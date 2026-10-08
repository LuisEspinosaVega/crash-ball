// server.cpp — Crash Ball game server.
//
// One process does three jobs:
//   1. Serves the browser client from `public/` over plain HTTP, so there is
//      nothing else to install or launch.
//   2. Keeps a lobby: rooms with share codes, a host, a roster and settings.
//   3. Runs the authoritative simulation of every active room.
//
// Threading model:
//   - the main thread runs the accept loop
//   - one detached thread per connection reads that client's messages
//   - one game thread ticks every room at a fixed 60 Hz and flushes the sockets
//
// Three rules make that safe, and everything else follows from them:
//
//   * The game loop never performs a blocking write. A stalled client (a laptop
//     that went to sleep, a phone on a train) can only ever lose its own frames,
//     never the match. Outgoing bytes live in a per-connection outbox that the
//     loop pushes at its own pace.
//
//   * The simulation runs on a fixed timestep. With a variable dt the physics
//     depend on frame pacing, so the same hit rebounds differently on a fast
//     machine than on a loaded one.
//
//   * Locks never nest in a cycle. `lobbyMutex_` may be taken with
//     `clientsMutex_` and with a per-connection `outMutex`, never the other way
//     round. The engine has its own mutex per room and is always used on its
//     own, with the lobby released first.

#ifdef _WIN32
#  ifndef NOMINMAX
// Defined before anything else: winsock2.h pulls in windows.h, whose min/max
// macros would otherwise break every std::min/std::max below.
#    define NOMINMAX
#  endif
#endif

#include "game_state.h"
#include "http_files.h"
#include "json.h"
#include "protocol.h"
#include "room.h"
#include "websocket.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef _WIN32
#  include <windows.h>
#  include <timeapi.h>
#endif

namespace {

constexpr int kTickHz = 60;
constexpr float kTickSeconds = 1.0f / static_cast<float>(kTickHz);
constexpr int kKeepaliveTicks = 10 * kTickHz;   // ping a quiet client every 10 s
constexpr int kPruneTicks = 30 * kTickHz;       // housekeeping every 30 s

constexpr int kClientTimeoutMs = 35000;     // silent for this long: dead
constexpr int kMaxQueueBytes = 24 * 1024;   // past this backlog, drop snapshots
constexpr int kSlowRetryMs = 40;            // retry cadence for a backed-up socket
constexpr int kSpectatorEveryNTicks = 6;    // spectators get 10 Hz, players 60

constexpr int64_t kReclaimGraceMs = 120000;  // keep an abandoned wall for 2 min
constexpr size_t kMaxRooms = 32;

constexpr int kHttpIdleTimeoutMs = 15000;
constexpr int kMaxRequestsPerConnection = 64;

std::atomic<bool> g_stop{false};

int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

extern "C" void onSignal(int) {
    g_stop.store(true);
}

void installSignalHandlers() {
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
}

void setUtf8Console() {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
}

// Windows sleeps in 15.6 ms steps by default, which would make a 16.6 ms tick
// land at ~32 Hz: half-speed physics, on a machine that looks idle. Asking for
// 1 ms granularity is what lets the loop actually hit 60.
void setHighResolutionTimer(bool enable) {
#ifdef _WIN32
    if (enable) {
        timeBeginPeriod(1);
    } else {
        timeEndPeriod(1);
    }
#else
    (void)enable;   // POSIX sleep granularity is already fine
#endif
}

// One connected browser (or test client).
struct Client {
    int id = 0;
    std::string sessionId;   // handed out on connect, remembered by the browser

    WebSocket ws;
    std::mutex outMutex;     // guards outbox and the flush of that buffer
    std::string outbox;

    std::atomic<bool> alive{true};
    std::atomic<bool> webSocketReady{false};
    std::atomic<int> seat{-1};      // engine seat, -1 in the lobby
    std::atomic<int64_t> lastSeenMs{0};
    std::atomic<int64_t> lastSlowMs{0};
    std::atomic<unsigned long long> activitySeen{0};
    std::atomic<unsigned long long> droppedFrames{0};

    Room* room = nullptr;    // guarded by lobbyMutex_
    std::string name;        // guarded by lobbyMutex_
};

class GameServer {
public:
    GameServer(uint16_t port, Difficulty difficulty, int roundsToWin)
        : port_(port),
          publicDir_(httpfiles::findPublicDir()),
          roundsToWin_(roundsToWin),
          quickDifficulty_(difficulty) {
        codeSeed_ = static_cast<std::uint64_t>(nowMs()) * 0x9E3779B97F4A7C15ULL;
        if (codeSeed_ == 0) codeSeed_ = 0x9E3779B97F4A7C15ULL;   // xorshift hates 0
    }

    bool run() {
        std::string error;
        listener_ = net::listenTcp(port_, 64, error);
        if (listener_ == net::kInvalidSocket) {
            std::cerr << "No se pudo abrir el puerto " << port_ << ": " << error
                      << "\n";
            return false;
        }

        createQuickRoom();
        printStartup();
        running_ = true;

        std::thread gameThread([this] { gameLoop(); });
        acceptLoop();

        shutdown();
        if (gameThread.joinable()) gameThread.join();
        return true;
    }

private:
    uint16_t port_;
    std::string publicDir_;
    int roundsToWin_;
    Difficulty quickDifficulty_;
    std::uint64_t codeSeed_ = 0;
    net::socket_t listener_ = net::kInvalidSocket;

    std::vector<std::shared_ptr<Room>> rooms_;
    std::mutex lobbyMutex_;

    std::vector<std::shared_ptr<Client>> clients_;
    std::unordered_map<int, std::shared_ptr<Client>> byId_;
    std::mutex clientsMutex_;

    std::atomic<int> activeClients_{0};
    std::atomic<int> nextClientId_{1};
    std::atomic<bool> running_{false};

    // ─── Startup ───────────────────────────────────────────────────

    // The "Jugar rapido" match: always running, always open, never listed. It
    // is what a bare JOIN lands in, which is also what keeps old clients and
    // the protocol tests working.
    void createQuickRoom() {
        RoomConfig config;
        config.title = "Partida rapida";
        config.isQuickRoom = true;
        config.roundsToWin = roundsToWin_;
        config.botDifficulty = quickDifficulty_;
        config.humanSlots = MAX_PLAYERS;

        auto room = std::make_shared<Room>("", config);
        {
            std::lock_guard<std::mutex> lock(room->engineMutex());
            room->engine().startMatch(config.roundsToWin);
        }
        room->setPhase(RoomPhase::Playing);
        rooms_.push_back(room);
    }

    void printStartup() const {
        std::cout << "  Cliente web : http://localhost:" << port_ << "\n";
        if (publicDir_.empty()) {
            std::cout << "  AVISO: no se encontro public/index.html; el servidor "
                         "de archivos no servirá el juego.\n";
        } else {
            std::cout << "  Archivos    : " << publicDir_ << "/\n";
        }
        std::cout << "  WebSocket   : ws://localhost:" << port_ << "\n";
        std::cout << "  Salas       : hasta " << kMaxRooms << " abiertas, "
                  << MAX_PLAYERS << " jugadores cada una\n";
        std::cout << "  Ctrl+C para detener.\n\n";
    }

    // ─── Outgoing bytes ────────────────────────────────────────────
    //
    // Nothing writes to a socket directly. Every message is appended to the
    // connection's outbox; the game loop pushes whatever the kernel accepts and
    // retries the rest on the next tick. That is the whole reason a slow client
    // cannot stall the simulation.

    bool enqueue(const std::shared_ptr<Client>& client, const std::string& payload,
                 bool droppable = false) {
        if (!client || !client->alive.load() || payload.empty()) return false;

        std::string frame;
        WebSocket::encodeText(payload, frame);

        std::lock_guard<std::mutex> lock(client->outMutex);
        // A snapshot is a complete picture of the world, so dropping one only
        // costs a little smoothness. Control messages are never dropped.
        if (droppable &&
            client->outbox.size() + frame.size() > static_cast<size_t>(kMaxQueueBytes)) {
            ++client->droppedFrames;
            return false;
        }
        client->outbox.append(frame);
        return true;
    }

    void enqueueFrame(const std::shared_ptr<Client>& client, uint8_t opcode,
                      const std::string& payload) {
        std::string frame;
        WebSocket::encodeFrame(opcode, payload, frame);
        std::lock_guard<std::mutex> lock(client->outMutex);
        client->outbox.append(frame);
    }

    void flush(const std::shared_ptr<Client>& client) {
        if (!client->ws.valid()) return;

        std::lock_guard<std::mutex> lock(client->outMutex);
        if (client->outbox.empty()) return;

        std::string pending;
        pending.swap(client->outbox);
        const WebSocket::Flush result = client->ws.flushPending(pending);

        if (result == WebSocket::Flush::Dead) {
            client->alive.store(false);
            return;
        }
        if (!pending.empty()) {
            // Nothing went out: remember it so we do not spin on a socket whose
            // buffer is full, and keep the bytes in front of anything queued
            // meanwhile.
            pending += client->outbox;
            client->outbox.swap(pending);
            client->lastSlowMs.store(nowMs());
        }
    }

    void flushAll() {
        for (const auto& client : snapshotClients()) flush(client);
    }

    // ─── Accept loop (main thread) ─────────────────────────────────

    void acceptLoop() {
        while (running_ && !g_stop.load()) {
            const int ready = net::waitReadable(listener_, 250);
            if (ready == 0) continue;   // just a timeout; re-check the flag
            if (ready < 0) break;

            net::socket_t raw = net::acceptTcp(listener_);
            if (raw == net::kInvalidSocket) {
                if (!running_ || g_stop.load()) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }

            net::setNoDelay(raw);
            // From here the socket is non-blocking: reads wait on select() (see
            // WebSocket::setReceiveWait) and writes return immediately.
            net::setNonBlocking(raw, true);

            auto client = std::make_shared<Client>();
            client->id = nextClientId_.fetch_add(1);
            client->sessionId = makeSessionId();
            client->ws.adopt(raw);
            client->lastSeenMs.store(nowMs());

            {
                std::lock_guard<std::mutex> lock(clientsMutex_);
                clients_.push_back(client);
                byId_[client->id] = client;
            }
            activeClients_.fetch_add(1);

            std::thread([this, client] {
                clientLoop(client);
                activeClients_.fetch_sub(1);
            }).detach();
        }
    }

    static std::string makeSessionId() {
        static std::mt19937_64 rng(static_cast<std::uint64_t>(
            std::chrono::steady_clock::now().time_since_epoch().count()) ^
            0x9E3779B97F4A7C15ULL);
        static std::mutex rngMutex;
        std::lock_guard<std::mutex> lock(rngMutex);
        const std::uint64_t r = rng();
        char buf[24];
        std::snprintf(buf, sizeof(buf), "%016llx",
                      static_cast<unsigned long long>(r));
        return std::string(buf);
    }

    /**
     * Identidad que el cliente dice tener, si es creíble.
     *
     * El sessionId lo elige el cliente, no el servidor: si lo generase el
     * servidor, cada conexión nueva sería una identidad distinta y la
     * reconexión nunca podría devolver el muro a su dueño. Aquí solo se valida
     * la forma (hex de 8 a 32 caracteres) y se normaliza a minúsculas; si no
     * vale, se genera uno, que es el camino de los clientes antiguos.
     */
    static std::string requestedSession(const std::string& raw) {
        if (raw.size() < 8 || raw.size() > 32) return std::string();
        std::string clean;
        clean.reserve(raw.size());
        for (char c : raw) {
            const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                             (c >= 'A' && c <= 'F');
            if (!hex) return std::string();
            clean.push_back((c >= 'A' && c <= 'F') ? static_cast<char>(c - 'A' + 'a') : c);
        }
        return clean;
    }

    // ─── Per-connection thread ─────────────────────────────────────

    void clientLoop(const std::shared_ptr<Client>& client) {
        std::string header;
        if (!client->ws.readRequestHeader(header)) {
            dropClient(client);
            return;
        }

        // One connection may carry several HTTP requests before (or instead of)
        // upgrading. Keep serving files until the request is actually a WebSocket
        // upgrade: a client may send the upgrade on a connection it already used
        // for HTTP, and answering that with a static file breaks the handshake.
        client->ws.setReceiveWait(kHttpIdleTimeoutMs);

        int served = 0;
        while (!isWebSocketUpgrade(header)) {
            if (!serveStaticRequest(client, header)) {
                dropClient(client);
                return;
            }
            if (++served >= kMaxRequestsPerConnection) {
                dropClient(client);
                return;
            }
            if (!client->ws.readRequestHeader(header)) {
                dropClient(client);
                return;
            }
        }

        // Answer the upgrade immediately rather than on the next tick: the
        // browser is blocked on this response.
        std::string response;
        const bool upgraded = client->ws.handshakeResponse(header, response);
        if (response.empty()) {
            dropClient(client);
            return;
        }
        {
            std::lock_guard<std::mutex> lock(client->outMutex);
            client->outbox.append(response);
        }
        flush(client);
        if (!upgraded) {
            dropClient(client);
            return;
        }
        client->webSocketReady.store(true);

        // The idle timeout exists only to reap abandoned HTTP connections; a
        // WebSocket must be able to sit quiet for as long as the player wants.
        client->ws.setReceiveWait(net::kWaitForever);

        enqueue(client, proto::hello(client->id, client->sessionId));

        std::string text;
        std::string pongPayload;
        while (running_ && !g_stop.load() && client->alive.load() &&
               client->ws.recvText(text)) {
            if (client->ws.takePendingPong(pongPayload)) {
                enqueueFrame(client, WebSocket::kOpPong, pongPayload);
            }
            client->lastSeenMs.store(nowMs());
            handleMessage(text, client);
        }

        leaveRoom(client);
        std::cout << "Cliente " << client->id << " desconectado\n";
        dropClient(client);
    }

    static bool isWebSocketUpgrade(const std::string& header) {
        std::string upgrade = WebSocket::headerValue(header, "upgrade");
        for (char& c : upgrade) {
            if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        }
        return upgrade == "websocket";
    }

    // Answers one static HTTP request. Returns false when the client asked to
    // close or the write failed, meaning the connection is finished.
    bool serveStaticRequest(const std::shared_ptr<Client>& client,
                            const std::string& header) {
        const std::string response = httpfiles::buildResponse(publicDir_, header);
        {
            std::lock_guard<std::mutex> lock(client->outMutex);
            client->outbox.append(response);
        }
        flush(client);

        std::string connection = WebSocket::headerValue(header, "connection");
        for (char& c : connection) {
            if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        }
        return connection.find("close") == std::string::npos;
    }

    void dropClient(const std::shared_ptr<Client>& client) {
        {
            std::lock_guard<std::mutex> lock(client->outMutex);
            client->alive.store(false);
        }
        client->ws.close();

        std::lock_guard<std::mutex> lock(clientsMutex_);
        clients_.erase(std::remove(clients_.begin(), clients_.end(), client),
                       clients_.end());
        byId_.erase(client->id);
    }

    // ─── Message routing ───────────────────────────────────────────

    void handleMessage(const std::string& text, const std::shared_ptr<Client>& client) {
        json::Value message;
        if (!json::parse(text, message) || !message.isObject()) return;

        const json::Value* typeField = message.find("type");
        if (typeField == nullptr) return;
        const std::string type = typeField->asString();

        if (type == "PING") {
            // Se devuelve la marca tal cual, sin castear:Date.now() no cabe en
            // un int y el cliente midía un RTT absurdo por culpa de eso.
            enqueue(client, "{\"type\":\"PONG\",\"t\":" +
                                proto::fieldNumberText(message, "t") + "}");
        } else if (type == "JOIN" || type == "QUICK") {
            handleQuickJoin(message, client);
        } else if (type == "ROOMS") {
            handleRoomList(client);
        } else if (type == "ROOM_CREATE") {
            handleRoomCreate(message, client);
        } else if (type == "ROOM_JOIN") {
            handleRoomJoin(message, client);
        } else if (type == "RESUME") {
            handleResume(message, client);
        } else if (type == "ROOM_LEAVE") {
            handleRoomLeave(client);
        } else if (type == "ROOM_CONFIG") {
            handleRoomConfig(message, client);
        } else if (type == "ROOM_START") {
            handleRoomStart(client);
        } else if (type == "ROOM_LOBBY") {
            handleRoomToLobby(client);
        } else if (type == "READY") {
            handleReady(message, client);
        } else if (type == "KICK") {
            handleKick(message, client);
        } else if (type == "CHAT") {
            handleChat(message, client);
        } else if (type == "INPUT") {
            handleInput(message, client);
        } else if (type == "DASH") {
            handleDash(client);
        } else if (type == "RESTART") {
            handleRestart(client);
        }
    }

    // A room plus the seat this client holds in it, resolved under the lobby
    // lock and then used without it.
    struct Membership {
        std::shared_ptr<Room> room;
        int seat = -1;
    };

    Membership membershipOf(const std::shared_ptr<Client>& client) {
        Membership result;
        std::lock_guard<std::mutex> lock(lobbyMutex_);
        result.room = roomOfLocked(client->id);
        result.seat = client->seat.load();
        return result;
    }

    std::shared_ptr<Room> roomOfLocked(int connId) {
        for (const auto& room : rooms_) {
            if (room->findByConn(connId) != nullptr) return room;
        }
        return nullptr;
    }

    std::shared_ptr<Room> findRoomLocked(const std::string& code) {
        for (const auto& room : rooms_) {
            if (!room->isQuickRoom() && room->code() == code) return room;
        }
        return nullptr;
    }

    std::string pickName(const json::Value& message,
                         const std::shared_ptr<Client>& client) {
        std::string name = proto::sanitizeName(proto::fieldString(message, "name", ""));
        if (name.empty()) {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            name = proto::sanitizeName(client->name);
        }
        if (name.empty()) name = "Jugador";
        return name;
    }

    // Adopta la identidad que trae el mensaje, si es válida. Se llama en cada
    // ruta de entrada para que la sesión sobreviva a las reconexiones.
    void adoptSession(const json::Value& message,
                      const std::shared_ptr<Client>& client) {
        const std::string wanted =
            requestedSession(proto::fieldString(message, "sessionId", ""));
        if (!wanted.empty()) {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (client->sessionId != wanted) client->sessionId = wanted;
        }
    }

    static int clampRounds(int rounds) {
        return std::max(1, std::min(9, rounds));
    }

    static int clampSlots(int slots) {
        return std::max(1, std::min(MAX_PLAYERS, slots));
    }

    // ─── Rooms ─────────────────────────────────────────────────────

    // Membership change, done in one place so the lobby lock, the engine lock
    // and the client's own fields never disagree. `seatNow` asks for a wall
    // immediately (quick room, or arriving mid-match).
    bool enterRoom(const std::shared_ptr<Client>& client, const std::shared_ptr<Room>& room,
                   const std::string& name, bool seatNow, std::string* errorCode,
                   std::string* errorText) {
        int seat = -1;
        bool needsSeat = false;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);

            if (room->findByConn(client->id) == nullptr) {
                if (!room->hasFreeSlot()) {
                    if (errorCode) *errorCode = "ROOM_FULL";
                    if (errorText) *errorText = "La sala esta llena";
                    return false;
                }
                room->addMember(client->id, client->sessionId, name);
            }
            client->name = name;
            client->room = room.get();
            needsSeat = seatNow && client->seat.load() < 0 &&
                        room->phase() != RoomPhase::Lobby;
            if (room->isQuickRoom()) needsSeat = seatNow;
        }

        if (needsSeat) {
            seat = seatInEngine(room, name);
            if (seat < 0) {
                if (errorCode) *errorCode = "ROOM_FULL";
                if (errorText) *errorText = "Los cuatro muros ya tienen dueño";
                leaveRoom(client);
                return false;
            }
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            client->seat.store(seat);
            if (RosterEntry* entry = room->findByConn(client->id)) {
                entry->seat = seat;
                entry->aiControlled = false;
            }
        }

        if (room->isQuickRoom()) {
            // Legacy shape, so a bare JOIN still gets WELCOME with its seat.
            const int finalSeat = seat >= 0 ? seat : client->seat.load();
            enqueue(client, proto::welcome(finalSeat, name, MAX_PLAYERS,
                                           roundsToWin_, "", client->sessionId));
        } else if (seat >= 0) {
            enqueue(client, proto::seatTaken(seat, name, room->code()));
        }
        return true;
    }

    // Calls engine.join under the engine lock only.
    int seatInEngine(const std::shared_ptr<Room>& room, const std::string& name) {
        std::lock_guard<std::mutex> lock(room->engineMutex());
        return room->engine().join(name);
    }

    void handleQuickJoin(const json::Value& message,
                         const std::shared_ptr<Client>& client) {
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (client->room != nullptr) return;   // already in a match
        }

        std::shared_ptr<Room> room;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (const auto& candidate : rooms_) {
                if (candidate->isQuickRoom()) {
                    room = candidate;
                    break;
                }
            }
        }
        if (!room) {
            enqueue(client, proto::reject("No hay partida rapida disponible"));
            return;
        }

        const std::string name = pickName(message, client);
        std::string code, text;
        if (!enterRoom(client, room, name, true, &code, &text)) {
            enqueue(client, proto::reject(text.empty()
                                              ? "La partida esta llena"
                                              : text));
            return;
        }

        // broadcastRoom() reaches the newcomer too, so there is no separate
        // view to send here.
        broadcastRoom(*room);
        std::cout << "Cliente " << client->id << " (\"" << name
                  << ") entro en la partida rapida, muro "
                  << GameEngine::wallName(static_cast<Wall>(client->seat.load()))
                  << "\n";
    }

    void handleRoomList(const std::shared_ptr<Client>& client) {
        std::vector<const Room*> visible;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (const auto& room : rooms_) {
                if (room->isQuickRoom()) continue;
                // Solo salas con gente conectada dentro: anunciar una sala
                // vacía es ruido, aunque su código siga sirviendo para volver.
                if (room->humansOnline() == 0) continue;
                visible.push_back(room.get());
            }
        }
        enqueue(client, proto::roomList(visible));
    }

    void handleRoomCreate(const json::Value& message,
                          const std::shared_ptr<Client>& client) {
        const std::string name = pickName(message, client);
        leaveRoom(client);   // one room at a time

        RoomConfig config;
        config.title = proto::sanitizeName(proto::fieldString(message, "title", ""));
        if (config.title.empty()) config.title = "Sala de " + name;
        config.roundsToWin = clampRounds(proto::fieldInt(message, "roundsToWin", roundsToWin_));
        config.botDifficulty = proto::difficultyFromName(
            proto::fieldString(message, "difficulty", ""), quickDifficulty_);
        config.humanSlots = clampSlots(proto::fieldInt(message, "humanSlots", MAX_PLAYERS));

        std::shared_ptr<Room> room;
        std::string failCode, failText;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (rooms_.size() >= kMaxRooms) {
                failCode = "SERVER_FULL";
                failText = "El servidor tiene demasiadas salas abiertas";
            } else {
                std::string code;
                for (int attempt = 0; attempt < 64; ++attempt) {
                    code = makeRoomCode(codeSeed_);
                    if (findRoomLocked(code) == nullptr) break;
                    code.clear();
                }
                if (code.empty()) {
                    failCode = "SERVER_FULL";
                    failText = "No se pudo generar un codigo de sala";
                } else {
                    room = std::make_shared<Room>(code, config);
                    room->addMember(client->id, client->sessionId, name);
                    client->name = name;
                    client->room = room.get();
                    client->seat.store(-1);
                    rooms_.push_back(room);
                }
            }
        }
        if (!room) {
            enqueue(client, proto::error(failCode.c_str(), failText));
            return;
        }

        {
            std::lock_guard<std::mutex> lock(room->engineMutex());
            room->engine().setBotDifficulty(config.botDifficulty);
            room->engine().setRoundsToWin(config.roundsToWin);
        }

        sendRoomView(client, room);
        std::cout << "Sala " << room->code() << " creada por \"" << name << "\"\n";
    }

    void handleRoomJoin(const json::Value& message,
                        const std::shared_ptr<Client>& client) {
        const std::string wanted = normalizeCode(proto::fieldString(message, "code", ""));

        std::shared_ptr<Room> room;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            room = findRoomLocked(wanted);
        }
        if (!room) {
            enqueue(client, proto::error("ROOM_NOT_FOUND",
                                         wanted.empty()
                                             ? "Falta el codigo de la sala"
                                             : "No existe la sala " + wanted));
            return;
        }

        // A client belongs to exactly one room: switching means leaving the old.
        leaveRoom(client);

        const std::string name = pickName(message, client);
        // Anyone arriving at a running room is seated at once, like the old
        // single-match behaviour, instead of waiting for the next round.
        bool midMatch = false;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            midMatch = room->phase() != RoomPhase::Lobby;
        }

        std::string failCode, failText;
        if (!enterRoom(client, room, name, midMatch, &failCode, &failText)) {
            enqueue(client, proto::error(failCode.c_str(), failText));
            return;
        }

        // broadcastRoom() reaches the newcomer too.
        broadcastRoom(*room);
        std::cout << "Cliente " << client->id << " (\"" << name << ") entro en la sala "
                  << room->code() << "\n";
    }

    // Reconnect: the browser remembers its session id, so a dropped connection
    // gets the same seat back instead of landing as a stranger. Only meaningful
    // for created rooms: the quick match hands walls to bots the moment a player
    // disappears, so there is nothing to reclaim there.
    void handleResume(const json::Value& message,
                      const std::shared_ptr<Client>& client) {
        adoptSession(message, client);

        std::shared_ptr<Room> room;
        int seat = -1;
        std::string name;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (client->room != nullptr) return;   // nothing to resume

            const std::string code = normalizeCode(proto::fieldString(message, "code", ""));
            std::vector<RosterEntry*> candidates;
            for (const auto& candidate : rooms_) {
                if (candidate->isQuickRoom()) continue;
                if (!code.empty() && candidate->code() != code) continue;
                if (RosterEntry* entry = candidate->findBySession(client->sessionId)) {
                    candidates.push_back(entry);
                }
            }
            // Prefer a room where they still hold a wall.
            RosterEntry* best = nullptr;
            for (RosterEntry* entry : candidates) {
                if (best == nullptr || entry->seat >= best->seat) best = entry;
            }
            if (best == nullptr) return;

            for (const auto& candidate : rooms_) {
                if (candidate->findBySession(client->sessionId) == best) {
                    room = candidate;
                    break;
                }
            }
            if (!room) return;

            name = best->name;
            seat = best->seat;
            best->connId = client->id;
            best->offlineSinceMs = 0;
            best->ready = true;
            client->name = name;
            client->room = room.get();
            room->promoteHost();
        }

        if (seat >= 0) {
            // Take the wall back from the AI that was holding it.
            std::lock_guard<std::mutex> lock(room->engineMutex());
            if (!room->engine().claimSeat(seat, name)) seat = -1;
        }
        if (seat >= 0) {
            client->seat.store(seat);
            enqueue(client, proto::seatTaken(seat, name, room->code()));
        }

        sendRoomView(client, room);
        broadcastRoom(*room);
        std::cout << "Cliente " << client->id << " (\"" << name
                  << ") recupero su sesion"
                  << (seat >= 0 ? (" en el asiento " + std::to_string(seat)) : "")
                  << "\n";
    }

    void handleRoomLeave(const std::shared_ptr<Client>& client) {
        if (!leaveRoom(client)) return;
        enqueue(client, proto::notice("Saliste de la sala"));
    }

    void handleRoomConfig(const json::Value& message,
                          const std::shared_ptr<Client>& client) {
        Membership membership = membershipOf(client);
        if (!membership.room) return;

        RoomConfig config = membership.room->config();
        bool changed = false;
        if (proto::findField(message, "roundsToWin")) {
            config.roundsToWin =
                clampRounds(proto::fieldInt(message, "roundsToWin", config.roundsToWin));
            changed = true;
        }
        if (proto::findField(message, "difficulty")) {
            config.botDifficulty = proto::difficultyFromName(
                proto::fieldString(message, "difficulty", ""), config.botDifficulty);
            changed = true;
        }
        if (proto::findField(message, "humanSlots")) {
            config.humanSlots =
                clampSlots(proto::fieldInt(message, "humanSlots", config.humanSlots));
            changed = true;
        }
        if (proto::findField(message, "title")) {
            const std::string title =
                proto::sanitizeName(proto::fieldString(message, "title"));
            if (!title.empty()) {
                config.title = title;
                changed = true;
            }
        }
        if (!changed) return;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (!membership.room->isHost(client->id)) return;
            if (membership.room->phase() != RoomPhase::Lobby) {
                failWith(client, "IN_PROGRESS",
                         "No se puede cambiar con la partida en curso");
                return;
            }
            membership.room->setConfig(config);
        }
        {
            std::lock_guard<std::mutex> lock(membership.room->engineMutex());
            membership.room->engine().setBotDifficulty(config.botDifficulty);
            membership.room->engine().setRoundsToWin(config.roundsToWin);
        }
        broadcastRoom(*membership.room);
    }

    void handleRoomStart(const std::shared_ptr<Client>& client) {
        Membership membership = membershipOf(client);
        if (!membership.room) return;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (!membership.room->isHost(client->id)) {
                failWith(client, "NOT_HOST", "Solo el anfitrion puede iniciar la partida");
                return;
            }
            if (membership.room->phase() == RoomPhase::Playing) return;
            if (membership.room->humansOnline() == 0) return;
        }
        startMatch(membership.room);
    }

    void handleRoomToLobby(const std::shared_ptr<Client>& client) {
        Membership membership = membershipOf(client);
        if (!membership.room) return;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (!membership.room->isHost(client->id)) {
                failWith(client, "NOT_HOST", "Solo el anfitrion puede hacer esto");
                return;
            }
        }
        returnToLobby(*membership.room);
    }

    void handleReady(const json::Value& message,
                     const std::shared_ptr<Client>& client) {
        const bool ready = proto::fieldBool(message, "ready", true);
        std::lock_guard<std::mutex> lock(lobbyMutex_);
        std::shared_ptr<Room> room = roomOfLocked(client->id);
        if (!room) return;
        RosterEntry* entry = room->findByConn(client->id);
        if (!entry) return;
        entry->ready = ready;
        broadcastRoomLocked(*room);
    }

    void handleKick(const json::Value& message,
                    const std::shared_ptr<Client>& client) {
        const int targetId = proto::fieldInt(message, "id", -1);
        if (targetId == client->id) return;

        std::shared_ptr<Room> room;
        std::shared_ptr<Client> target;
        int seat = -1;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            room = roomOfLocked(client->id);
            if (!room || !room->isHost(client->id)) return;
            RosterEntry* entry = room->findByConn(targetId);
            if (!entry) return;
            seat = entry->seat;
            room->removeMember(targetId);
            target = clientByIdLocked(targetId);
            if (target) {
                target->room = nullptr;
                target->seat.store(-1);
            }
        }

        if (seat >= 0) {
            // A kicked player gives the wall back for good.
            std::lock_guard<std::mutex> lock(room->engineMutex());
            room->engine().leave(seat);
        }
        if (target) {
            enqueue(target, proto::kicked("El anfitrion te expulso de la sala"));
            enqueue(target, proto::notice("Expulsado de " + room->code()));
        }
        broadcastRoom(*room);
    }

    void handleChat(const json::Value& message,
                    const std::shared_ptr<Client>& client) {
        std::string text = proto::sanitizeName(proto::fieldString(message, "text", ""));
        if (text.size() > 140) text.resize(140);
        if (text.empty()) return;

        Membership membership = membershipOf(client);
        if (!membership.room) return;

        std::string from;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            from = client->name;
        }
        broadcastToRoom(*membership.room, proto::chat(from, text));
    }

    void handleInput(const json::Value& message,
                     const std::shared_ptr<Client>& client) {
        const Membership membership = membershipOf(client);
        if (!membership.room || membership.seat < 0) return;

        const json::Value* move = proto::findField(message, "move");
        const float value = move ? static_cast<float>(move->asNumber(0.0)) : 0.0f;

        std::lock_guard<std::mutex> lock(membership.room->engineMutex());
        membership.room->engine().setMove(membership.seat, value);
    }

    void handleDash(const std::shared_ptr<Client>& client) {
        const Membership membership = membershipOf(client);
        if (!membership.room || membership.seat < 0) return;

        std::lock_guard<std::mutex> lock(membership.room->engineMutex());
        membership.room->engine().requestDash(membership.seat);
    }

    void handleRestart(const std::shared_ptr<Client>& client) {
        const Membership membership = membershipOf(client);
        if (!membership.room) return;

        // In the quick match anybody may call the rematch (it was open before
        // there were rooms); a real room only listens to its host.
        if (!membership.room->isQuickRoom() && !membership.room->isHost(client->id)) return;

        startMatch(membership.room, true);
    }

    // ─── Match / lobby transitions ─────────────────────────────────

    // `rematchOnly` refuses when the room is not finished yet, which is how
    // RESTART keeps its old "only after the match is decided" behaviour.
    void startMatch(const std::shared_ptr<Room>& room, bool rematchOnly = false) {
        RoomConfig config;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (rematchOnly && room->phase() != RoomPhase::Finished) return;
            if (room->phase() == RoomPhase::Playing) return;
            config = room->config();
        }

        // Seat everyone without a wall, one at a time: the engine is touched
        // under its own mutex with the lobby released.
        std::vector<std::pair<int, std::string>> pending;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (const RosterEntry& entry : room->roster()) {
                if (entry.online() && entry.seat < 0) {
                    pending.emplace_back(entry.connId, entry.name);
                }
            }
        }

        std::vector<int> newSeats;
        for (const auto& item : pending) {
            const int seat = seatInEngine(room, item.second);
            if (seat < 0) break;   // every wall already has a live human
            newSeats.push_back(seat);
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            if (RosterEntry* entry = room->findByConn(item.first)) {
                entry->seat = seat;
                entry->aiControlled = false;
            }
            if (std::shared_ptr<Client> owner = clientById(item.first)) {
                owner->seat.store(seat);
            }
        }

        {
            std::lock_guard<std::mutex> lock(room->engineMutex());
            room->engine().startMatch(config.roundsToWin);
        }
        room->setPhase(RoomPhase::Playing);

        for (const int seat : newSeats) {
            int connId = -1;
            {
                std::lock_guard<std::mutex> lock(lobbyMutex_);
                if (RosterEntry* entry = room->findBySeat(seat)) {
                    connId = entry->connId;
                }
            }
            if (connId < 0) continue;
            if (std::shared_ptr<Client> owner = clientById(connId)) {
                enqueue(owner, proto::seatTaken(seat, owner->name, room->code()));
            }
        }

        broadcastRoom(*room);
        std::cout << "Sala " << (room->code().empty() ? std::string("(rapida)") : room->code())
                  << ": match started, " << room->rosterSize() << " player(s)\n";
    }

    void returnToLobby(Room& room) {
        std::vector<std::shared_ptr<Client>> members;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (RosterEntry& entry : room.rosterRef()) {
                entry.seat = -1;
                entry.aiControlled = false;
                entry.ready = false;
            }
            members = membersOfLocked(room);
            for (const auto& member : members) member->seat.store(-1);
        }
        {
            std::lock_guard<std::mutex> lock(room.engineMutex());
            room.engine().stopMatch();
        }
        room.setPhase(RoomPhase::Lobby);
        broadcastRoom(room);
    }

    // Removes a client from whatever room it is in. Returns false when it was
    // not in one.
    bool leaveRoom(const std::shared_ptr<Client>& client) {
        std::shared_ptr<Room> room;
        int seat = -1;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            std::shared_ptr<Room> found = roomOfLocked(client->id);
            client->room = nullptr;
            client->seat.store(-1);
            if (!found) return false;
            room = found;

            RosterEntry* entry = room->findByConn(client->id);
            if (entry) {
                seat = entry->seat;
                if (room->isQuickRoom()) {
                    // The quick match must never keep a wall for an absent
                    // player, so the roster entry goes and a bot takes over.
                    room->removeMember(client->id);
                } else {
                    // In a room the seat is held for the grace window: the AI
                    // plays it, and the player gets it back when they return.
                    room->markOffline(*entry, nowMs());
                    if (room->hostId() == client->id) room->promoteHost();
                }
            }
        }

        if (seat >= 0) {
            std::lock_guard<std::mutex> lock(room->engineMutex());
            room->engine().hostToBot(seat);
        }
        broadcastRoom(*room);
        return true;
    }

    // ─── Broadcasting ──────────────────────────────────────────────

    // Collects the live members under both locks; the actual sending happens
    // with nothing held.
    std::vector<std::shared_ptr<Client>> membersOfLocked(Room& room) {
        std::vector<int> ids;
        for (const RosterEntry& entry : room.roster()) {
            if (entry.online()) ids.push_back(entry.connId);
        }

        std::vector<std::shared_ptr<Client>> members;
        std::lock_guard<std::mutex> lock(clientsMutex_);
        members.reserve(ids.size());
        for (int id : ids) {
            std::shared_ptr<Client> client = clientByIdLocked(id);
            if (client) members.push_back(client);
        }
        return members;
    }

    std::vector<std::shared_ptr<Client>> membersOf(Room& room) {
        std::lock_guard<std::mutex> lock(lobbyMutex_);
        return membersOfLocked(room);
    }

    void broadcastToRoom(Room& room, const std::string& payload) {
        for (const auto& member : membersOf(room)) enqueue(member, payload);
    }

    // The lobby view is personalised (who is the host, who is you), so it is
    // rebuilt per member rather than sent as one blob.
    void broadcastRoom(Room& room) {
        std::vector<std::pair<int, std::string>> views;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (const RosterEntry& entry : room.roster()) {
                if (entry.online()) {
                    views.emplace_back(entry.connId, proto::room(room, entry.connId));
                }
            }
        }
        sendViews(views);
    }

    // Same, for callers that already hold the lobby lock.
    void broadcastRoomLocked(Room& room) {
        std::vector<std::pair<int, std::string>> views;
        for (const RosterEntry& entry : room.roster()) {
            if (entry.online()) views.emplace_back(entry.connId, proto::room(room, entry.connId));
        }
        sendViews(views);
    }

    // Turns (connection id, payload) pairs into sends. The pairing is by id, not
    // by position: a player may have left between building and sending.
    void sendViews(const std::vector<std::pair<int, std::string>>& views) {
        std::vector<std::pair<std::shared_ptr<Client>, std::string>> targets;
        {
            std::lock_guard<std::mutex> lock(clientsMutex_);
            targets.reserve(views.size());
            for (const auto& view : views) {
                std::shared_ptr<Client> client = clientByIdLocked(view.first);
                if (client) targets.emplace_back(client, view.second);
            }
        }
        for (const auto& target : targets) enqueue(target.first, target.second);
    }

    // Builds and sends one personalised lobby view.
    void sendRoomView(const std::shared_ptr<Client>& client,
                      const std::shared_ptr<Room>& room) {
        std::string payload;
        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            payload = proto::room(*room, client->id);
        }
        enqueue(client, payload);
    }

    void failWith(const std::shared_ptr<Client>& client, const char* code,
                  const std::string& text) {
        enqueue(client, proto::error(code, text));
    }

    std::shared_ptr<Client> clientById(int connId) {
        std::lock_guard<std::mutex> lock(clientsMutex_);
        return clientByIdLocked(connId);
    }

    std::shared_ptr<Client> clientByIdLocked(int connId) {
        const auto it = byId_.find(connId);
        return it == byId_.end() ? nullptr : it->second;
    }

    std::vector<std::shared_ptr<Room>> snapshotRooms() {
        std::lock_guard<std::mutex> lock(lobbyMutex_);
        return rooms_;
    }

    std::vector<std::shared_ptr<Client>> snapshotClients() {
        std::lock_guard<std::mutex> lock(clientsMutex_);
        return clients_;
    }

    // ─── Game loop thread ──────────────────────────────────────────
    //
    // Fixed timestep: exactly one simulation step per tick, and the deadline
    // accumulates instead of the sleep being "16 ms", so the loop neither drifts
    // nor runs slow just because a tick took 17 ms.

    void gameLoop() {
        using clock = std::chrono::steady_clock;
        const auto period = std::chrono::nanoseconds(1000000000LL / kTickHz);
        auto nextTick = clock::now();

        unsigned long long tick = 0;

        while (running_ && !g_stop.load()) {
            const std::vector<std::shared_ptr<Room>> rooms = snapshotRooms();

            for (const auto& room : rooms) {
                std::lock_guard<std::mutex> lock(room->engineMutex());
                room->engine().update(kTickSeconds);
                if (room->phase() == RoomPhase::Playing &&
                    room->engine().state().round.matchOver) {
                    room->setPhase(RoomPhase::Finished);
                }
            }

            ++tick;
            publish(rooms, tick);

            if (tick % kKeepaliveTicks == 0) keepalive();
            if (tick % kPruneTicks == 0) housekeeping();

            flushAll();

            nextTick += period;
            const auto now = clock::now();
            // Fell far behind (a stalled machine, dozens of rooms): resync
            // instead of trying to catch up tick by tick.
            if (now > nextTick + period * 8) nextTick = now;
            std::this_thread::sleep_until(nextTick);
        }
    }

    void publish(const std::vector<std::shared_ptr<Room>>& rooms,
                 unsigned long long tick) {
        for (const auto& room : rooms) {
            if (room->phase() == RoomPhase::Lobby) continue;   // lobby: no arena

            std::string payload;
            bool started = false;
            {
                std::lock_guard<std::mutex> lock(room->engineMutex());
                payload = proto::state(*room, room->engine().state(),
                                       room->engine().matchStarted(), tick);
                started = room->engine().matchStarted();
            }

            // Players get every frame; spectators every 6th. Someone who is
            // only watching does not need 60 snapshots a second.
            const bool slowPass =
                (tick % static_cast<unsigned long long>(kSpectatorEveryNTicks)) == 0;

            for (const auto& member : membersOf(*room)) {
                if (member->seat.load() >= 0 || slowPass) {
                    enqueue(member, payload, true);
                }
            }
        }
    }

    void keepalive() {
        const int64_t now = nowMs();
        for (const auto& client : snapshotClients()) {
            if (!client->alive.load() || !client->webSocketReady.load()) continue;

            const int64_t idle = now - client->lastSeenMs.load();

            // recvText() se queda bloqueado dentro del socket consumiendo tramas
            // de control, así que un espectador que no pulsa nada nunca pasa por
            // el hilo de lectura. El contador de tráfico del socket es lo que
            // dice si el cliente sigue ahí: sin esto, mirar y ser desconectado a
            // los 35 s.
            const unsigned long long activity = client->ws.activity();
            if (activity != client->activitySeen.load(std::memory_order_relaxed)) {
                client->activitySeen.store(activity, std::memory_order_relaxed);
                client->lastSeenMs.store(now);
            } else if (idle > kClientTimeoutMs) {
                std::cout << "Cliente " << client->id << " descartado por inactividad ("
                          << idle << " ms)\n";
                client->alive.store(false);
                client->ws.close();
                continue;
            }

            std::lock_guard<std::mutex> lock(client->outMutex);
            // A socket whose kernel buffer is full is not necessarily dead; do
            // not even try to ping it.
            if (client->outbox.size() > static_cast<size_t>(kMaxQueueBytes) ||
                now - client->lastSlowMs.load() < kSlowRetryMs) {
                continue;
            }
            WebSocket::encodeFrame(WebSocket::kOpPing, "", client->outbox);
        }
    }

    // Gives the walls of players who never came back to the AI for good, and
    // forgets rooms nobody is in any more.
    void housekeeping() {
        const int64_t now = nowMs();
        std::vector<std::pair<std::shared_ptr<Room>, std::vector<int>>> released;
        std::vector<std::shared_ptr<Room>> dead;

        {
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (const auto& room : rooms_) {
                std::vector<int> freed = room->pruneOffline(now, kReclaimGraceMs);
                if (!freed.empty()) released.emplace_back(room, freed);
                if (room->rosterSize() == 0 && !room->isQuickRoom()) dead.push_back(room);
            }
            rooms_.erase(std::remove_if(rooms_.begin(), rooms_.end(),
                                        [&dead](const std::shared_ptr<Room>& r) {
                                            return std::find(dead.begin(), dead.end(), r) !=
                                                   dead.end();
                                        }),
                         rooms_.end());
        }

        for (const auto& item : released) {
            {
                std::lock_guard<std::mutex> lock(item.first->engineMutex());
                for (const int seat : item.second) item.first->engine().leave(seat);
            }
            broadcastRoom(*item.first);
            std::cout << "Sala " << item.first->code()
                      << ": muro liberado (jugador que no volvio)\n";
        }
    }

    // ─── Shutdown ──────────────────────────────────────────────────

    void shutdown() {
        if (!running_.exchange(false)) return;
        g_stop.store(true);

        net::closeSocket(listener_);
        listener_ = net::kInvalidSocket;

        // Say goodbye politely, then give the loop a moment to push those frames
        // out before the sockets die.
        for (const auto& client : snapshotClients()) {
            std::lock_guard<std::mutex> lock(client->outMutex);
            WebSocket::encodeClose(1001, client->outbox);
        }
        flushAll();
        std::this_thread::sleep_for(std::chrono::milliseconds(120));

        {
            // Nobody is "in" a room any more, so the disconnect paths of the
            // reader threads become no-ops instead of mutating dead rosters.
            std::lock_guard<std::mutex> lock(lobbyMutex_);
            for (const auto& room : rooms_) {
                for (RosterEntry& entry : room->rosterRef()) entry.connId = -1;
            }
        }
        for (const auto& client : snapshotClients()) {
            client->alive.store(false);
            client->ws.close();
        }

        for (int i = 0; i < 200 && activeClients_.load() > 0; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        std::cout << "\nServidor detenido.\n";
    }
};

Difficulty parseDifficulty(const std::string& text, bool& ok) {
    ok = true;
    if (text == "easy" || text == "0") return Difficulty::Easy;
    if (text == "medium" || text == "1") return Difficulty::Medium;
    if (text == "hard" || text == "2") return Difficulty::Hard;
    if (text == "expert" || text == "3") return Difficulty::Expert;
    ok = false;
    return Difficulty::Hard;
}

// ─── Self test ─────────────────────────────────────────────────────
//
// `server.exe --selftest` checks the pieces that fail silently and would be
// miserable to debug from a browser: the handshake hash (a wrong
// Sec-WebSocket-Accept makes every client refuse to connect), base64, and the
// room-code alphabet. Cheap, offline, and it catches regressions in seconds.

std::string sha1Hex(const std::string& text) {
    Sha1 sha;
    sha.update(reinterpret_cast<const uint8_t*>(text.data()), text.size());
    uint8_t digest[20];
    sha.finish(digest);
    static const char* kHex = "0123456789abcdef";
    std::string out;
    out.reserve(40);
    for (int i = 0; i < 20; ++i) {
        out.push_back(kHex[digest[i] >> 4]);
        out.push_back(kHex[digest[i] & 0x0F]);
    }
    return out;
}

int selftest() {
    int failures = 0;
    const auto expect = [&failures](const char* what, const std::string& got,
                                    const std::string& want) {
        const bool ok = got == want;
        if (!ok) ++failures;
        std::cout << (ok ? "PASS  " : "FAIL  ") << what << "  -- " << got;
        if (!ok) std::cout << " (esperado " << want << ")";
        std::cout << "\n";
    };

    // RFC 3174 / FIPS 180-1 vectors.
    expect("sha1(\"\")", sha1Hex(""),
           "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect("sha1(\"abc\")", sha1Hex("abc"),
           "a9993e364706816aba3e25717850c26c9cd0d89d");
    expect("sha1(448-bit message)", sha1Hex(
               "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
           "84983e441c3bd26ebaae4aa1f95129e5e54670f1");

    // RFC 6455 §1.3: this exact key/accept pair.
    expect("websocket accept key", computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
           "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

    // Room codes: five letters/digits, nothing confusable.
    std::uint64_t seed = 12345;
    bool alphabetOk = true;
    std::string sample;
    for (int i = 0; i < 2000; ++i) {
        const std::string code = makeRoomCode(seed);
        if (i < 3) sample += code + " ";
        for (char c : code) {
            if (c == '0' || c == '1' || c == 'O' || c == 'I') alphabetOk = false;
        }
    }
    expect("room codes avoid 0/1/O/I", alphabetOk ? "2000 codes limpios" : "caracter prohibido",
           "2000 codes limpios");
    std::cout << "INFO  muestra de codigos: " << sample << "\n";

    // Names: no control characters, no runaway length, no broken UTF-8 tail.
    expect("nombre con 40 chars se recorta",
           proto::sanitizeName(std::string(40, 'x')).size() == 16 ? "16" : "?",
           "16");
    expect("nombre con saltos de linea se limpia",
           proto::sanitizeName(" a\nb\tc "), "abc");

    std::cout << (failures == 0 ? "\nselftest: todo correcto\n"
                                : "\nselftest: " + std::to_string(failures) +
                                      " fallo(s)\n");
    return failures == 0 ? 0 : 1;
}

}  // namespace

// ─── Entry point ───────────────────────────────────────────────────

int main(int argc, char** argv) {
    setUtf8Console();
    setHighResolutionTimer(true);
    installSignalHandlers();

    if (argc > 1 && std::string(argv[1]) == "--selftest") return selftest();

    uint16_t port = 8080;
    Difficulty difficulty = Difficulty::Hard;
    int roundsToWin = ROUNDS_TO_WIN;

    if (argc > 1) {
        try {
            const int parsed = std::stoi(argv[1]);
            if (parsed > 0 && parsed <= 65535) {
                port = static_cast<uint16_t>(parsed);
            } else {
                std::cerr << "Puerto fuera de rango: " << argv[1] << ". Usando 8080.\n";
            }
        } catch (...) {
            std::cerr << "Puerto invalido: " << argv[1] << ". Usando 8080.\n";
        }
    }

    if (argc > 2) {
        bool ok = false;
        const Difficulty parsed = parseDifficulty(argv[2], ok);
        if (ok) {
            difficulty = parsed;
        } else {
            std::cerr << "Dificultad invalida: " << argv[2]
                      << " (usa easy|medium|hard|expert). Usando hard.\n";
        }
    }

    if (argc > 3) {
        try {
            const int parsed = std::stoi(argv[3]);
            if (parsed >= 1 && parsed <= 9) {
                roundsToWin = parsed;
            } else {
                std::cerr << "Rondas fuera de rango (1-9): " << argv[3] << ". Usando "
                          << ROUNDS_TO_WIN << ".\n";
            }
        } catch (...) {
            std::cerr << "Rondas invalidas: " << argv[3] << ". Usando " << ROUNDS_TO_WIN
                      << ".\n";
        }
    }

    std::cout << "========================================\n";
    std::cout << "        CRASH BALL ARENA - SERVIDOR     \n";
    std::cout << "========================================\n";
    std::cout << "  Puerto      : " << port << "\n";
    std::cout << "  Jugadores   : hasta " << MAX_PLAYERS
              << " por sala (los muros libres los ocupan bots)\n";
    std::cout << "  Dificultad  : ";
    switch (difficulty) {
        case Difficulty::Easy:   std::cout << "easy\n";   break;
        case Difficulty::Medium: std::cout << "medium\n"; break;
        case Difficulty::Hard:   std::cout << "hard\n";   break;
        case Difficulty::Expert: std::cout << "expert\n"; break;
    }
    std::cout << "  Rondas      : primero a " << roundsToWin << "\n";
    std::cout << "  Protocolo   : WebSocket (RFC 6455) + HTTP en el mismo puerto\n";
    std::cout << "\n";

    if (!net::startup()) {
        std::cerr << "\nNo se pudo inicializar la libreria de red.\n";
        return 1;
    }

    GameServer server(port, difficulty, roundsToWin);
    const bool started = server.run();

    setHighResolutionTimer(false);
    net::shutdown();
    return started ? 0 : 1;
}