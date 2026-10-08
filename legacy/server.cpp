// server.cpp — Crash Ball TCP Server
// Multiplayer server for Crash Ball: 4-player arena game

#include "game_state.h"
#include <iostream>
#include <thread>
#include <mutex>
#include <string>
#include <vector>
#include <algorithm>
#include <sstream>
#include <unordered_map>
#include <chrono>
#include <cstring>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#ifdef _WIN32
#include <winsock2.h>
#endif

// ─── Forward Declarations ────────────────────────────────────────────

std::string serializeGameState(const GameState& state);
std::string jsonStr(const std::string& key, const std::string& val);

// ─── Socket Abstraction ─────────────────────────────────────────────

class Socket {
public:
    void create();
    void bind(int port);
    void listen(int backlog);
    int accept(void* addr, socklen_t* addrlen);
    void close();
    int write(const char* data, int len);
    int read(char* buffer, int len);
    int getFd();

    ~Socket() { close(); }

private:
#ifdef _WIN32
    SOCKET sock_ = INVALID_SOCKET;
#else
    int fd_ = -1;
#endif
};

void Socket::create() {
#ifdef _WIN32
    static bool wsaInitialized = false;
    if (!wsaInitialized) {
        WSADATA wsaData;
        if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
            std::cerr << "WSAStartup failed: " << WSAGetLastError() << "\n";
            return;
        }
        wsaInitialized = true;
    }
    sock_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock_ == INVALID_SOCKET) {
        std::cerr << "socket() failed: " << WSAGetLastError() << "\n";
    }
#else
    fd_ = socket(AF_INET, SOCK_STREAM, 0);
#endif
}

void Socket::bind(int port) {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
#ifdef _WIN32
    if (::bind(sock_, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        std::cerr << "bind() failed on port " << port << ": " << WSAGetLastError() << "\n";
    }
#else
    if (::bind(fd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        std::cerr << "bind() failed on port " << port << "\n";
    }
#endif
}

void Socket::listen(int backlog) {
#ifdef _WIN32
    ::listen(sock_, backlog);
#else
    ::listen(fd_, backlog);
#endif
}

int Socket::accept(void* addr, socklen_t* addrlen) {
#ifdef _WIN32
    return (int)::accept(sock_, (struct sockaddr*)addr, addrlen);
#else
    return ::accept(fd_, (struct sockaddr*)addr, addrlen);
#endif
}

void Socket::close() {
#ifdef _WIN32
    if (sock_ != INVALID_SOCKET) {
        closesocket(sock_);
        sock_ = INVALID_SOCKET;
    }
    // NOTE: WSACleanup() belongs to the process, not to a single socket.
    // Calling it here tore down every other connection on the first disconnect.
#else
    if (fd_ != -1) {
        ::close(fd_);
        fd_ = -1;
    }
#endif
}

int Socket::write(const char* data, int len) {
#ifdef _WIN32
    return (int)send(sock_, data, len, 0);
#else
    return (int)send(fd_, data, len, 0);
#endif
}

int Socket::read(char* buffer, int len) {
#ifdef _WIN32
    return (int)recv(sock_, buffer, len, 0);
#else
    return recv(fd_, buffer, len, 0);
#endif
}

int Socket::getFd() {
#ifdef _WIN32
    return static_cast<int>(sock_);
#else
    return fd_;
#endif
}

// ─── Client Session ─────────────────────────────────────────────────

struct ClientSession {
    int id = -1;
    int fd = -1;
    bool connected = false;
    uint16_t seatIndex = 0;
    char name[32];
};

// ─── Helper: Parse JSON-like messages ────────────────────────────────

static int extractInt(const std::string& json, const std::string& key) {
    size_t pos = json.find(key);
    if (pos == std::string::npos) return -1;
    pos += key.size() + 1; // skip key and ":"
    if (pos >= json.size() || json[pos] != '"') return -1;
    pos++; // skip opening quote
    size_t end = json.find('"', pos);
    if (end == std::string::npos) return -1;
    try {
        return std::stoi(json.substr(pos, end - pos));
    } catch (...) {
        return -1;
    }
}

static float extractFloat(const std::string& json, const std::string& key) {
    size_t pos = json.find(key);
    if (pos == std::string::npos) return 0.0f;
    pos += key.size() + 1;
    if (pos >= json.size() || json[pos] != '"') return 0.0f;
    pos++;
    size_t end = json.find('"', pos);
    if (end == std::string::npos) return 0.0f;
    try {
        return std::stof(json.substr(pos, end - pos));
    } catch (...) {
        return 0.0f;
    }
}

static std::string extractString(const std::string& json, const std::string& key) {
    size_t pos = json.find(key);
    if (pos == std::string::npos) return "";
    pos += key.size() + 1;
    if (pos >= json.size() || json[pos] != '"') return "";
    pos++;
    size_t end = json.find('"', pos);
    if (end == std::string::npos) return "";
    return json.substr(pos, end - pos);
}

// ─── WebSocket Helpers ────────────────────────────────────────────────

static std::string generateWebSocketAcceptKey(const std::string& key) {
    static const std::string magic = "258EAFA5-E914-47DA-A2B7-D9C3B038DAE4F";
    std::string result = key + magic;

    // XOR each byte with the magic key
    for (size_t i = 0; i < result.size(); i++) {
        result[i] ^= magic[i % magic.size()];
    }

    // Base64 encode
    static const std::string base64Table =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string encoded;
    unsigned char charArray[3] = {0};
    size_t i = 0;

    for (i = 0; i < result.size(); i += 3) {
        charArray[0] = (unsigned char)(i < result.size() ? result[i] : 0);
        charArray[1] = (unsigned char)((i + 1) < result.size() ? result[i + 1] : 0);
        charArray[2] = (unsigned char)((i + 2) < result.size() ? result[i + 2] : 0);

        unsigned int chunk =
            (unsigned int)charArray[0] << 16 |
            (unsigned int)charArray[1] << 8 |
            (unsigned int)charArray[2];

        encoded += base64Table[(chunk >> 16) & 0x3F];
        encoded += base64Table[(chunk >> 8) & 0x3F];
        encoded += base64Table[(chunk >> 0) & 0x3F];
        encoded += base64Table[(chunk >> 22) & 0x3F];
    }

    // Remove trailing padding (=)
    if (encoded.size() >= 2) {
        encoded.resize(encoded.size() - 2);
    }
    return encoded;
}

static std::string extractWebSocketKey(const std::string& message) {
    size_t pos = message.find("Sec-WebSocket-Key: ");
    if (pos == std::string::npos) return "";
    pos += 17; // Length of "Sec-WebSocket-Key: "
    size_t end = message.find('\r');
    if (end != std::string::npos) {
        return message.substr(pos, end - pos);
    }
    return message.substr(pos);
}

static void sendWebSocketAccept(const std::string& key, Socket& clientSocket) {
    std::string acceptKey = generateWebSocketAcceptKey(key);
    std::string response =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
    clientSocket.write(response.c_str(), response.size());
}

static std::string decodeWebSocketFrame(const std::string& frame) {
    if (frame.empty()) return "";

    // First byte: mask and opcode
    uint8_t firstByte = static_cast<uint8_t>(frame[0]);
    bool masked = (firstByte & 0x80) != 0;
    uint8_t opcode = firstByte & 0x7F;

    // Skip first byte (opcode/mask)
    size_t offset = 1;
    uint8_t length = frame[offset] & 0x7F;
    offset++;

    if (length == 0x7F) {
        // Extended length (16-bit)
        length = (static_cast<uint8_t>(frame[offset]) << 8) | frame[offset + 1];
        offset += 2;
    }

    // Mask key buffer (always 4 bytes if masked)
    char maskKey[4];
    if (masked) {
        maskKey[0] = static_cast<char>(frame[offset]);
        maskKey[1] = static_cast<char>(frame[offset + 1]);
        maskKey[2] = static_cast<char>(frame[offset + 2]);
        maskKey[3] = static_cast<char>(frame[offset + 3]);
        offset += 4;
    }

    // Extract payload
    size_t payloadLen = frame.size() - static_cast<size_t>(offset);
    std::string payload;
    payload.reserve(payloadLen);
    for (size_t i = 0; i < payloadLen; i++) {
        payload += static_cast<char>(frame[offset + i]);
    }

    // Unmask if necessary
    if (masked) {
        for (size_t i = 0; i < payload.size(); i++) {
            payload[i] ^= maskKey[i % 4];
        }
    }

    return payload;
}

// ─── Game Server ────────────────────────────────────────────────────

class CrashBallServer {
public:
    CrashBallServer(int port = 8080);
    ~CrashBallServer();
    void run();

private:
    uint16_t port_;
    GameEngine engine_;

    Socket serverSocket_;
    bool running_ = false;

    std::vector<ClientSession> clients_;
    std::unordered_map<int, int> fdToSeat_;
    std::unordered_map<int, int> seatToFd_;
    std::mutex clientMutex_;

    void start();
    void gameLoop();
    void handleClientInternal(int fd);
    void broadcastState();
};

// ─── Server Lifecycle ───────────────────────────────────────────────
// These four members were declared in the class but never defined, which
// is what actually broke the link (LNK2019 x4 / LNK1120).

CrashBallServer::CrashBallServer(int port)
    : port_(static_cast<uint16_t>(port)) {
}

CrashBallServer::~CrashBallServer() {
    running_ = false;
    serverSocket_.close();
#ifdef _WIN32
    WSACleanup();
#endif
}

void CrashBallServer::run() {
    start();
}

void CrashBallServer::gameLoop() {
    using clock = std::chrono::steady_clock;
    constexpr float TICK_SECONDS = 1.0f / 60.0f;

    auto last = clock::now();
    while (running_) {
        auto now = clock::now();
        float dt = std::chrono::duration<float>(now - last).count();
        last = now;

        // Clamp so a stalled thread cannot spiral the simulation.
        if (dt > 0.25f) dt = 0.25f;

        engine_.updateBots(dt);
        engine_.update(dt);
        broadcastState();

        std::this_thread::sleep_for(
            std::chrono::milliseconds(static_cast<int>(TICK_SECONDS * 1000)));
    }
}

void CrashBallServer::start() {
    running_ = true;
    serverSocket_.create();
    serverSocket_.bind(port_);
    serverSocket_.listen(8);

    std::cout << "Crash Ball Server listening on port " << port_ << "\n";
    std::cout << "Waiting for players...\n";

    // Start game loop
    std::thread([&] { gameLoop(); }).detach();

    // Accept connections
    while (running_) {
        struct sockaddr_in addr;
        socklen_t addrlen = sizeof(addr);
        int fd = serverSocket_.accept(&addr, &addrlen);
        if (fd < 0) {
            std::cerr << "Accept error\n";
            continue;
        }

        ClientSession session;
        session.id = static_cast<int>(clients_.size());
        session.fd = fd;
        session.connected = true;
        session.seatIndex = static_cast<uint16_t>(session.id);
        std::snprintf(session.name, sizeof(session.name), "Player %d", session.id);

        {
            std::lock_guard<std::mutex> lock(clientMutex_);
            clients_.push_back(session);
            fdToSeat_[fd] = static_cast<int>(session.seatIndex);
            seatToFd_[static_cast<int>(session.seatIndex)] = fd;
        }

        std::cout << "Client " << session.id << " connected\n";

        // Handle this client in a separate thread
        std::thread([this, fd] {
            handleClientInternal(fd);
        }).detach();
    }
}

// ─── Client Handler (WebSocket-aware) ─────────────────────────────────

void CrashBallServer::handleClientInternal(int fd) {
    char buffer[4096];
    int bytes;
    bool wsHandshakeSent = false;

    while (running_) {
        bytes = serverSocket_.read(buffer, sizeof(buffer) - 1);
        if (bytes <= 0) {
            break;
        }
        buffer[bytes] = '\0';

        std::string msg(buffer, bytes);

        // Detect WebSocket upgrade handshake
        if (!wsHandshakeSent && msg.find("GET / HTTP") != std::string::npos) {
            std::string wsKey = extractWebSocketKey(msg);
            if (!wsKey.empty()) {
                sendWebSocketAccept(wsKey, serverSocket_);
                wsHandshakeSent = true;
                std::cout << "WebSocket upgrade" << std::endl;
                continue;
            }
        }

        std::string payload = msg;
        if (wsHandshakeSent) {
            // Check for WebSocket frame: opcode 0x91 (text data)
            if (!msg.empty() && (static_cast<uint8_t>(msg[0]) & 0x80) == 0
                && (msg[0] & 0x7F) == 0x91) {
                payload = decodeWebSocketFrame(msg);
            }
        }

        // Process JSON message types
        if (payload.find("\"type\":\"JOIN\"") != std::string::npos) {
            int seat = extractInt(payload, "seat");
            int type = extractInt(payload, "playerType");

            // Just update the client's name if seat exists
            if (seat >= 0 && seat < static_cast<int>(clients_.size())) {
                std::lock_guard<std::mutex> lock(clientMutex_);
                if (clients_[seat].connected) {
                    if (type == 0) {
                        std::string name = extractString(payload, "name");
                        if (!name.empty()) {
                            strncpy(clients_[seat].name, name.c_str(), sizeof(clients_[seat].name) - 1);
                            clients_[seat].name[sizeof(clients_[seat].name) - 1] = '\0';
                        }
                    }
                }
            }

            // Add player to game
            PlayerType playerType = (type == 0) ? PlayerType::HUMAN : PlayerType::BOT;
            const char* playerName = extractString(payload, "name").c_str();
            if (!playerName || playerName[0] == '\0') {
                playerName = clients_[clients_.size() - 1].name;
            }

            uint16_t playerIdx = engine_.addPlayer(playerType, playerName);
            if (playerIdx < MAX_PLAYERS) {
                broadcastState();
            }
        } else if (payload.find("\"type\":\"INPUT\"") != std::string::npos) {
            int player = extractInt(payload, "player");
            float move = extractFloat(payload, "move");
            if (player >= 0 && player < MAX_PLAYERS) {
                engine_.processInput(static_cast<uint16_t>(player), 0.016f, move);
            }
        } else if (payload.find("\"type\":\"ATTACK\"") != std::string::npos) {
            int player = extractInt(payload, "player");
            if (player >= 0 && player < MAX_PLAYERS) {
                if (!engine_.isEliminated(static_cast<uint16_t>(player))) {
                    // Get non-const reference for modifying state
                    auto& state = engine_.getMutableState();
                    if (state.players[player].attackTimer <= 0.0f && state.players[player].health > 0) {
                        // Modify the player's attack timer via processInput
                        engine_.processInput(static_cast<uint16_t>(player), 0.016f, 0.0f);
                        // Reset attack timer via direct access
                        state.players[player].attackTimer = ATTACK_COOLDOWN;

                        // Boost balls
                        for (uint16_t b = 0; b < static_cast<uint16_t>(state.round.ballCount); b++) {
                            auto& ball = state.balls[b];
                            float ballSide = ball.vx > 0 ? 1.0f : -1.0f;
                            if (ballSide * player > 0) {
                                float speed = std::sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
                                float newSpeed = speed * ATTACK_SPEED_MULTIPLIER;
                                if (newSpeed > static_cast<float>(BALL_SPEED_MAX)) {
                                    newSpeed = static_cast<float>(BALL_SPEED_MAX);
                                }
                                float angle = std::atan2(ball.vy, ball.vx);
                                ball.vx = std::cos(angle) * newSpeed;
                                ball.vy = std::sin(angle) * newSpeed;
                            }
                        }
                    }
                }
            }
        }
    }

    // Cleanup on disconnect
    serverSocket_.close();

    {
        std::lock_guard<std::mutex> lock(clientMutex_);
        fdToSeat_.erase(fd);
        for (auto& client : clients_) {
            if (client.fd == fd) {
                client.connected = false;
                break;
            }
        }
        int seat = -1;
        for (auto& pair : fdToSeat_) {
            if (pair.second == fd) {
                seat = pair.first;
                break;
            }
        }
        if (seat >= 0) seatToFd_.erase(seat);
    }

    broadcastState();
    std::cout << "Client disconnected\n";
}

// ─── Broadcast Helper ────────────────────────────────────────────────

void CrashBallServer::broadcastState() {
    std::string state = serializeGameState(engine_.getState());
    for (auto& client : clients_) {
        if (client.connected) {
            serverSocket_.write(state.c_str(), state.size());
        }
    }
}

// ─── JSON Helpers ────────────────────────────────────────────────────

std::string jsonStr(const std::string& key, const std::string& val) {
    return "\"" + key + "\": \"" + val + "\"";
}

std::string serializeGameState(const GameState& state) {
    std::ostringstream oss;
    oss << "{";

    // Round info
    oss << jsonStr("round", std::to_string(static_cast<int>(state.round.roundNumber))) << ",";
    oss << jsonStr("gameTime", std::to_string(static_cast<int>(state.round.gameTime))) << ",";
    oss << jsonStr("ballCount", std::to_string(static_cast<int>(state.round.ballCount)));
    oss << ",";

    // Players
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        const auto& p = state.players[i];
        oss << "{" << jsonStr("index", std::to_string(static_cast<int>(i))) << ",";
        oss << jsonStr("x", std::to_string(static_cast<int>(p.x))) << ",";
        oss << jsonStr("y", std::to_string(static_cast<int>(p.y))) << ",";
        oss << jsonStr("vx", std::to_string(static_cast<int>(p.vx))) << ",";
        oss << jsonStr("vy", std::to_string(static_cast<int>(p.vy))) << ",";
        oss << jsonStr("health", std::to_string(static_cast<int>(p.health))) << ",";
        oss << jsonStr("eliminated", (p.eliminated ? "1" : "0")) << ",";
        oss << jsonStr("type", (p.type == PlayerType::HUMAN ? "0" : "1")) << ",";
        oss << jsonStr("name", std::string(p.name));
        oss << ",";
    }

    // Balls
    for (uint16_t b = 0; b < static_cast<uint16_t>(state.round.ballCount); b++) {
        const auto& ball = state.balls[b];
        oss << "{" << jsonStr("idx", std::to_string(static_cast<int>(b))) << ",";
        oss << jsonStr("x", std::to_string(static_cast<int>(ball.x))) << ",";
        oss << jsonStr("y", std::to_string(static_cast<int>(ball.y))) << ",";
        oss << jsonStr("vx", std::to_string(static_cast<int>(ball.vx))) << ",";
        oss << jsonStr("vy", std::to_string(static_cast<int>(ball.vy))) << ",";
        oss << jsonStr("speed", std::to_string(static_cast<int>(ball.speedLevel)));
        oss << ",";
    }

    oss << "}";
    return oss.str();
}

// ─── Main ──────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    uint16_t port = 8080;
    if (argc > 1) {
        try { port = static_cast<uint16_t>(std::stoi(argv[1])); }
        catch (...) { port = 8080; }
    }

    std::cout << "=== Crash Ball Server ===\n";
    std::cout << "Port: " << port << "\n";
    std::cout << "Max Players: 4\n";
    std::cout << "Type: PVP Arena\n";
    std::cout << "========================\n\n";

    CrashBallServer server(port);
    server.run();

    return 0;
}
