// server.cpp — Crash Ball game server.
//
// One process does two jobs:
//   1. Serves the browser client from `public/` over plain HTTP, so there is
//      nothing else to install or launch.
//   2. Hosts the authoritative game over WebSocket on the same port.
//
// Threading model:
//   - the main thread runs the accept loop
//   - one detached thread per connection reads that client's messages
//   - one game thread ticks the engine at ~60 Hz and broadcasts the state
// The engine is guarded by `engineMutex_` (critical sections are tiny); each
// connection has its own `writeMutex` so a slow client cannot interleave
// frames or stall another client's send.

#include "game_state.h"
#include "http_files.h"
#include "json.h"
#include "websocket.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#  include <windows.h>
#endif

namespace {

constexpr int TICK_MILLIS = 16;      // ~60 updates per second
std::atomic<bool> g_stop{false};

extern "C" void onSignal(int) {
    g_stop.store(true);
}

void installSignalHandlers() {
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
}

// One connected browser (or test client).
struct Client {
    int id = 0;
    WebSocket ws;
    int seat = -1;
    std::string name;
    std::atomic<bool> alive{true};

    // Set only once the WebSocket upgrade has completed. Until then this
    // connection is a plain HTTP request and must never receive a game frame:
    // the accept loop registers every socket before that decision is made, so
    // without this flag a GET / can race the game loop and come back with a
    // binary frame spliced into its HTTP response.
    std::atomic<bool> webSocketReady{false};

    std::mutex writeMutex;   // serialises writes to this socket
};

void setUtf8Console() {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
}

// ─── Protocol serialisation ────────────────────────────────────────

std::string serializeState(const GameState& s) {
    std::string out;
    out.reserve(1600);

    out += "{\"type\":\"STATE\",\"round\":{";
    out += "\"roundNumber\":" + std::to_string(s.round.roundNumber);
    out += ",\"gameTime\":" +
           std::to_string(static_cast<long long>(s.round.gameTime * 1000.0f));
    out += ",\"roundOver\":";
    out += s.round.roundOver ? "true" : "false";
    out += ",\"matchOver\":";
    out += s.round.matchOver ? "true" : "false";
    out += ",\"winner\":" + std::to_string(s.round.winner);
    out += ",\"matchWinner\":" + std::to_string(s.round.matchWinner);
    out += ",\"countdown\":" + json::number(s.round.countdown, 1);
    out += ",\"roundsToWin\":" + std::to_string(s.round.roundsToWin);
    out += ",\"startHealth\":" + std::to_string(INITIAL_HEALTH);
    out += "},\"players\":[";

    for (int i = 0; i < MAX_PLAYERS; ++i) {
        const PlayerState& p = s.players[i];
        if (i > 0) out += ",";
        out += "{\"seat\":" + std::to_string(p.seat);
        out += ",\"name\":\"" + json::escape(p.name) + "\"";
        out += ",\"bot\":";
        out += p.isBot ? "true" : "false";
        out += ",\"present\":";
        out += p.occupied ? "true" : "false";
        out += ",\"alive\":";
        out += p.alive ? "true" : "false";
        out += ",\"hp\":" + std::to_string(p.hp);
        out += ",\"roundsWon\":" + std::to_string(p.roundsWon);
        out += ",\"x\":" + json::number(p.x, 1);
        out += ",\"y\":" + json::number(p.y, 1);
        out += ",\"vx\":" + json::number(p.vx, 1);
        out += ",\"vy\":" + json::number(p.vy, 1);
        out += ",\"wall\":\"";
        out += GameEngine::wallName(p.wall);
        out += "\"";
        out += ",\"dashing\":";
        out += p.dashing ? "true" : "false";
        out += "}";
    }

    out += "],\"balls\":[";
    bool first = true;
    for (int i = 0; i < MAX_BALLS; ++i) {
        const BallState& b = s.balls[i];
        if (!b.active) continue;
        if (!first) out += ",";
        first = false;
        out += "{\"x\":" + json::number(b.x, 1);
        out += ",\"y\":" + json::number(b.y, 1);
        out += ",\"vx\":" + json::number(b.vx, 1);
        out += ",\"vy\":" + json::number(b.vy, 1);
        out += "}";
    }
    out += "]}";
    return out;
}

// Looks a field up at the top level, falling back to a nested "data" object so
// both {"type":"INPUT","move":-1} and {"type":"INPUT","data":{"move":-1}} work.
const json::Value* findField(const json::Value& message, const char* key) {
    if (const json::Value* direct = message.find(key)) return direct;

    const json::Value* data = message.find("data");
    if (data != nullptr && data->isObject()) return data->find(key);

    return nullptr;
}

// Keeps a player-supplied name to something safe for output: no control
// characters, no leading/trailing space, at most 16 bytes, and never split in
// the middle of a UTF-8 sequence.
std::string sanitizeName(const std::string& raw) {
    std::string clean;
    clean.reserve(raw.size());
    for (unsigned char c : raw) {
        if (c >= 0x20 && c != 0x7F) clean.push_back(static_cast<char>(c));
    }

    const size_t begin = clean.find_first_not_of(" \t");
    if (begin == std::string::npos) return std::string();
    const size_t end = clean.find_last_not_of(" \t");
    clean = clean.substr(begin, end - begin + 1);

    if (clean.size() > 16) {
        clean.resize(16);
        while (!clean.empty() &&
               (static_cast<unsigned char>(clean.back()) & 0xC0) == 0x80) {
            clean.pop_back();
        }
    }
    return clean;
}

// ─── Server ────────────────────────────────────────────────────────

class GameServer {
public:
    GameServer(uint16_t port, Difficulty difficulty, int roundsToWin)
        : port_(port),
          publicDir_(httpfiles::findPublicDir()),
          roundsToWin_(roundsToWin) {
        engine_.setBotDifficulty(difficulty);
        engine_.setRoundsToWin(roundsToWin);
    }

    bool run() {
        std::string error;
        listener_ = net::listenTcp(port_, 32, error);
        if (listener_ == net::kInvalidSocket) {
            std::cerr << "No se pudo abrir el puerto " << port_ << ": " << error
                      << "\n";
            return false;
        }

        printStartup();
        running_ = true;

        std::thread gameThread([this] { gameLoop(); });
        acceptLoop();

        shutdown();
        if (gameThread.joinable()) gameThread.join();
        return true;
    }

private:
    // Abandoned HTTP keep-alive connections are reaped after this long; a
    // completed WebSocket clears the timeout entirely.
    static constexpr int kHttpIdleTimeoutMillis = 15000;
    static constexpr int kMaxRequestsPerConnection = 64;

    uint16_t port_;
    std::string publicDir_;
    int roundsToWin_ = ROUNDS_TO_WIN;
    net::socket_t listener_ = net::kInvalidSocket;

    GameEngine engine_;
    std::mutex engineMutex_;

    std::vector<std::shared_ptr<Client>> clients_;
    std::mutex clientsMutex_;
    std::atomic<int> activeClients_{0};
    std::atomic<int> nextClientId_{1};
    std::atomic<bool> running_{false};

    void printStartup() const {
        std::cout << "  Cliente web : http://localhost:" << port_ << "\n";
        if (publicDir_.empty()) {
            std::cout << "  AVISO: no se encontro public/index.html; el servidor "
                         "de archivos no servira el juego.\n";
        } else {
            std::cout << "  Archivos    : " << publicDir_ << "/\n";
        }
        std::cout << "  WebSocket   : ws://localhost:" << port_ << "\n";
        std::cout << "  Ctrl+C para detener.\n\n";
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
            net::setSendTimeout(raw, 2000);

            auto client = std::make_shared<Client>();
            client->id = nextClientId_.fetch_add(1);
            client->ws.adopt(raw);

            {
                std::lock_guard<std::mutex> lock(clientsMutex_);
                clients_.push_back(client);
            }
            activeClients_.fetch_add(1);

            std::thread([this, client] {
                clientLoop(client);
                activeClients_.fetch_sub(1);
            }).detach();
        }
    }

    // ─── Per-connection thread ─────────────────────────────────────

    void clientLoop(const std::shared_ptr<Client>& client) {
        std::string header;
        if (!client->ws.readRequestHeader(header)) {
            dropClient(client);
            return;
        }

        // One connection may carry several HTTP requests before (or instead
        // of) upgrading. Keep serving files until the request is actually a
        // WebSocket upgrade — a client is allowed to send the upgrade on a
        // connection it already used for HTTP, and answering that with a
        // static file would break the handshake.
        client->ws.setReceiveTimeout(kHttpIdleTimeoutMillis);

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

        if (!client->ws.acceptHandshake(header)) {
            dropClient(client);
            return;
        }
        client->webSocketReady.store(true);

        // The idle timeout exists only to reap abandoned HTTP connections; a
        // WebSocket must be able to sit quiet for as long as the player wants.
        client->ws.setReceiveTimeout(0);

        std::cout << "Cliente " << client->id << " conectado\n";

        std::string text;
        while (running_ && !g_stop.load() && client->alive.load() &&
               client->ws.recvText(text)) {
            handleMessage(text, client);
        }

        if (client->seat >= 0) {
            std::lock_guard<std::mutex> lock(engineMutex_);
            engine_.leave(client->seat);
            std::cout << "Asiento " << client->seat << " liberado (cliente "
                      << client->id << ")\n";
            client->seat = -1;
        }
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
            std::lock_guard<std::mutex> lock(client->writeMutex);
            if (!client->ws.sendRaw(response)) return false;
        }

        std::string connection = WebSocket::headerValue(header, "connection");
        for (char& c : connection) {
            if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        }
        return connection.find("close") == std::string::npos;
    }

    void dropClient(const std::shared_ptr<Client>& client) {
        {
            std::lock_guard<std::mutex> lock(client->writeMutex);
            client->alive.store(false);
            client->ws.close();
        }
        std::lock_guard<std::mutex> lock(clientsMutex_);
        clients_.erase(std::remove(clients_.begin(), clients_.end(), client),
                       clients_.end());
    }

    // ─── Message handling ──────────────────────────────────────────

    void handleMessage(const std::string& text, const std::shared_ptr<Client>& client) {
        json::Value message;
        if (!json::parse(text, message) || !message.isObject()) return;

        const json::Value* typeField = message.find("type");
        if (typeField == nullptr) return;
        const std::string type = typeField->asString();

        if (type == "JOIN") {
            handleJoin(message, client);
        } else if (type == "INPUT") {
            if (client->seat < 0) return;
            const json::Value* move = findField(message, "move");
            const float value =
                move ? static_cast<float>(move->asNumber(0.0)) : 0.0f;
            std::lock_guard<std::mutex> lock(engineMutex_);
            engine_.setMove(client->seat, value);
        } else if (type == "DASH") {
            if (client->seat < 0) return;
            std::lock_guard<std::mutex> lock(engineMutex_);
            engine_.requestDash(client->seat);
        } else if (type == "RESTART") {
            std::lock_guard<std::mutex> lock(engineMutex_);
            engine_.requestRestart();
        }
    }

    void handleJoin(const json::Value& message, const std::shared_ptr<Client>& client) {
        if (client->seat >= 0) return;   // already seated

        std::string name = "Jugador";
        if (const json::Value* nameField = findField(message, "name")) {
            const std::string candidate = sanitizeName(nameField->asString());
            if (!candidate.empty()) name = candidate;
        }

        int seat;
        {
            std::lock_guard<std::mutex> lock(engineMutex_);
            seat = engine_.join(name);
        }

        if (seat < 0) {
            sendTo(client,
                   "{\"type\":\"REJECT\",\"reason\":\"La partida ya tiene cuatro "
                   "jugadores humanos\"}");
            client->alive.store(false);
            return;
        }

        client->seat = seat;
        client->name = name;

        std::string welcome = "{\"type\":\"WELCOME\",\"seat\":";
        welcome += std::to_string(seat);
        welcome += ",\"name\":\"" + json::escape(name) + "\"";
        welcome += ",\"maxPlayers\":" + std::to_string(MAX_PLAYERS);
        welcome += ",\"wall\":\"";
        welcome += GameEngine::wallName(static_cast<Wall>(seat));
        welcome += "\",\"roundsToWin\":" + std::to_string(roundsToWin_);
        welcome += ",\"startHealth\":" + std::to_string(INITIAL_HEALTH);
        welcome += "}";

        sendTo(client, welcome);
        std::cout << "Cliente " << client->id << " (\"" << name
                  << "\") ocupa el asiento " << seat << " ["
                  << GameEngine::wallName(static_cast<Wall>(seat)) << "]\n";
    }

    // ─── Sending ───────────────────────────────────────────────────

    bool sendTo(const std::shared_ptr<Client>& client, const std::string& payload) {
        // Only ever write game traffic to a completed WebSocket connection.
        if (!client->webSocketReady.load()) return false;

        std::lock_guard<std::mutex> lock(client->writeMutex);
        if (!client->alive.load() || !client->ws.valid()) return false;

        if (!client->ws.sendText(payload)) {
            client->alive.store(false);
            // Closing unblocks the reader so the seat is freed promptly.
            client->ws.close();
            return false;
        }
        return true;
    }

    std::vector<std::shared_ptr<Client>> snapshotClients() {
        std::lock_guard<std::mutex> lock(clientsMutex_);
        return clients_;
    }

    void broadcast(const std::string& payload) {
        for (const auto& client : snapshotClients()) {
            sendTo(client, payload);
        }
    }

    // ─── Game loop thread ──────────────────────────────────────────

    void gameLoop() {
        using clock = std::chrono::steady_clock;

        auto last = clock::now();
        while (running_ && !g_stop.load()) {
            const auto now = clock::now();
            const float dt = std::chrono::duration<float>(now - last).count();
            last = now;

            std::string payload;
            {
                std::lock_guard<std::mutex> lock(engineMutex_);
                engine_.update(dt);
                payload = serializeState(engine_.state());
            }
            broadcast(payload);

            std::this_thread::sleep_for(std::chrono::milliseconds(TICK_MILLIS));
        }
    }

    // ─── Shutdown ──────────────────────────────────────────────────

    void shutdown() {
        if (!running_.exchange(false)) return;
        g_stop.store(true);

        net::closeSocket(listener_);
        listener_ = net::kInvalidSocket;

        // Ask every connection to go away, then wait for its thread to finish
        // so nothing touches this object after the destructor runs.
        for (const auto& client : snapshotClients()) {
            std::lock_guard<std::mutex> lock(client->writeMutex);
            client->alive.store(false);
            client->ws.sendClose(1001);
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

}  // namespace

// ─── Entry point ───────────────────────────────────────────────────

int main(int argc, char** argv) {
    setUtf8Console();
    installSignalHandlers();

    uint16_t port = 8080;
    Difficulty difficulty = Difficulty::Hard;
    int roundsToWin = ROUNDS_TO_WIN;

    if (argc > 1) {
        try {
            const int parsed = std::stoi(argv[1]);
            if (parsed > 0 && parsed <= 65535) {
                port = static_cast<uint16_t>(parsed);
            } else {
                std::cerr << "Puerto fuera de rango: " << argv[1]
                          << ". Usando 8080.\n";
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
                std::cerr << "Rondas fuera de rango (1-9): " << argv[3]
                          << ". Usando " << ROUNDS_TO_WIN << ".\n";
            }
        } catch (...) {
            std::cerr << "Rondas invalidas: " << argv[3] << ". Usando "
                      << ROUNDS_TO_WIN << ".\n";
        }
    }

    std::cout << "========================================\n";
    std::cout << "        CRASH BALL ARENA - SERVIDOR     \n";
    std::cout << "========================================\n";
    std::cout << "  Puerto      : " << port << "\n";
    std::cout << "  Jugadores   : hasta " << MAX_PLAYERS
              << " (los asientos libres son bots)\n";
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

    net::shutdown();
    return started ? 0 : 1;
}
