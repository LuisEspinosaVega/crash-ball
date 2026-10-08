// network.h — Protocolo binario para mensajes cliente-servidor
// Crudo: Crash Ball Server

#ifndef NETWORK_H
#define NETWORK_H

#include <cstdint>
#include <array>
#include <vector>
#include <cstring>

#pragma pack(push, 1)

// ─── Mensajes del servidor a clientes ──────────────────────────────

struct PacketHeader {
    uint16_t magic;     // 0xABCD
    uint8_t  type;      // Tipo de mensaje
    uint8_t  payloadLen; // Longitud del payload
};

enum class MessageType : uint8_t {
    JOIN_REQUEST,         // Cliente pide unirse
    JOIN_RESPONSE,        // Respuesta de entrada
    GAME_STATE,           // Estado completo del juego
    GAME_STATE_PARTIAL,   // Delta de cambios
    PLAYER_INFO,          // Info de un player
    PLAYER_ELIMINATED,    // Notificación de eliminación
    ROUND_START,          // Inicio de ronda
    ROUND_END,            // Final de ronda
    SCORE_UPDATE,         // Cambio de puntuación
    PLAYER_COUNT_UPDATE,  // Cambio en número de jogadores
    DISCONNECT,           // Cliente desconectado
    ERROR,                // Error
};

enum class BallType : uint8_t {
    STANDARD,
    FAST,
    HEAVY,
    SPIN,
};

// ─── Payloads ──────────────────────────────────────────────────────

struct JoinResponsePayload {
    uint8_t  seatIndex;   // Posición en arena (0-3)
    uint8_t  playerType;  // 0 = humano, 1 = bot
    uint16_t maxClients;  // Límite de clientes
    char     playerName[32];
};

struct PlayerStatePayload {
    float    x, y;         // Posición en arena
    float    vx, vy;       // Velocidad (si es bot)
    uint8_t  playerIndex;  // Índice del player
    uint16_t health;      // Salud (0-15)
    uint8_t  isEliminated; // 1 si eliminado
    uint8_t  playerType;   // 0 = humano, 1 = bot
    char     name[32];
};

struct BallStatePayload {
    float    x, y, vx, vy;
    uint8_t  ballType;     // Tipo de pelota
    uint8_t  ownerIndex;   // -1 = ninguna
    uint8_t  speedLevel;   // Nivel de velocidad (1-10)
};

struct GameStatePayload {
    uint16_t ballCount;
    uint16_t activePlayerCount;
    uint16_t roundNumber;
    uint16_t gameTime;      // Tiempo de la ronda en milisegundos
    PlayerStatePayload players[4];
    BallStatePayload balls[16];  // Máximo 16 pelotas simultáneas
};

// ─── Helper: Serialize / Deserialize ───────────────────────────────

static inline size_t serializePacket(MessageType type, const void* data, size_t len, std::vector<uint8_t>& out) {
    out.resize(sizeof(PacketHeader) + len);
    PacketHeader h;
    h.magic = 0xABCD;
    h.type = static_cast<uint8_t>(type);
    h.payloadLen = len;
    memcpy(out.data(), &h, sizeof(h));
    if (len > 0) memcpy(out.data() + sizeof(h), data, len);
    return out.size();
}

static inline int deserializePacket(const uint8_t* data, size_t len, MessageType& type, void* out, size_t outLen) {
    if (len < sizeof(PacketHeader)) return -1;
    PacketHeader h;
    if (memcpy(&h, data, sizeof(h)) != 0) return -1;
    if (h.magic != 0xABCD) return -1;
    type = static_cast<MessageType>(h.type);
    if (len < sizeof(h) + h.payloadLen) return -1;
    if (out) memcpy(out, data + sizeof(h), h.payloadLen);
    return 0;
}

// ─── Helper: Build messages ────────────────────────────────────────

static inline std::vector<uint8_t> makeJoinResponse(uint8_t seat, uint8_t type, uint16_t max, const char* name) {
    JoinResponsePayload p;
    p.seatIndex = seat;
    p.playerType = type;
    p.maxClients = max;
    strncpy(p.playerName, name, sizeof(p.playerName) - 1);
    p.playerName[sizeof(p.playerName) - 1] = '\0';
    std::vector<uint8_t> out;
    serializePacket(MessageType::JOIN_RESPONSE, &p, sizeof(p), out);
    return out;
}

static inline std::vector<uint8_t> makeGameState(const GameStatePayload& state) {
    std::vector<uint8_t> out;
    serializePacket(MessageType::GAME_STATE, &state, sizeof(state), out);
    return out;
}

static inline std::vector<uint8_t> makeBallUpdate(BallStatePayload& ball) {
    std::vector<uint8_t> out;
    serializePacket(MessageType::GAME_STATE_PARTIAL, &ball, sizeof(ball), out);
    return out;
}

static inline std::vector<uint8_t> makeScoreUpdate(uint16_t playerIndex, uint16_t health) {
    uint8_t data[] = {static_cast<uint8_t>(playerIndex), static_cast<uint8_t>(health & 0xFF), health >> 8};
    std::vector<uint8_t> out;
    serializePacket(MessageType::SCORE_UPDATE, data, 3, out);
    return out;
}

static inline std::vector<uint8_t> makePlayerEliminated(uint16_t playerIndex) {
    uint8_t data[] = {static_cast<uint8_t>(playerIndex), static_cast<uint8_t>(playerIndex >> 8)};
    std::vector<uint8_t> out;
    serializePacket(MessageType::PLAYER_ELIMINATED, data, 2, out);
    return out;
}

static inline std::vector<uint8_t> makeRoundStart(uint16_t roundNum) {
    uint16_t data[] = {roundNum & 0xFFFF};
    std::vector<uint8_t> out;
    serializePacket(MessageType::ROUND_START, data, 2, out);
    return out;
}

static inline std::vector<uint8_t> makeRoundEnd(uint16_t winnerIndex, uint16_t finalScore[4]) {
    uint16_t data[4];
    for (int i = 0; i < 4; i++) data[i] = finalScore[i];
    data[4] = winnerIndex;
    std::vector<uint8_t> out;
    serializePacket(MessageType::ROUND_END, data, sizeof(data), out);
    return out;
}

static inline std::vector<uint8_t> makeError(const char* msg) {
    char buf[256];
    snprintf(buf, sizeof(buf), "Error: %s", msg);
    std::vector<uint8_t> out;
    serializePacket(MessageType::ERROR, buf, strlen(buf), out);
    return out;
}

#pragma pack(pop)

#endif // NETWORK_H
