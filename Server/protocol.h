// protocol.h — JSON payloads for both directions.
//
// Kept apart from server.cpp so the wire format can be read (and changed) in
// one place. Every message the client may send is listed in handleMessage()
// over there; everything the server may send is produced here.

#ifndef CRASHBALL_PROTOCOL_H
#define CRASHBALL_PROTOCOL_H

#include "game_state.h"
#include "json.h"
#include "room.h"

#include <string>

namespace proto {

// ─── Reading client messages ────────────────────────────────────────

// Looks a field up at the top level, falling back to a nested "data" object so
// both {"type":"INPUT","move":-1} and {"type":"INPUT","data":{"move":-1}} work.
inline const json::Value* findField(const json::Value& message, const char* key) {
    if (const json::Value* direct = message.find(key)) return direct;

    const json::Value* data = message.find("data");
    if (data != nullptr && data->isObject()) return data->find(key);

    return nullptr;
}

inline std::string fieldString(const json::Value& message, const char* key,
                               const std::string& fallback = std::string()) {
    const json::Value* field = findField(message, key);
    return field ? field->asString(fallback) : fallback;
}

inline int fieldInt(const json::Value& message, const char* key, int fallback) {
    const json::Value* field = findField(message, key);
    if (!field) return fallback;
    return static_cast<int>(field->asNumber(static_cast<double>(fallback)));
}

inline bool fieldBool(const json::Value& message, const char* key, bool fallback) {
    const json::Value* field = findField(message, key);
    if (!field) return fallback;
    if (field->isBool()) return field->boolean;
    if (field->isNumber()) return field->number != 0.0;
    return fallback;
}

// Keeps a player-supplied name to something safe for output: no control
// characters, no leading/trailing space, at most 16 bytes, and never split in
// the middle of a UTF-8 sequence.
inline std::string sanitizeName(const std::string& raw) {
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

inline const char* difficultyName(Difficulty difficulty) {
    switch (difficulty) {
        case Difficulty::Easy:   return "easy";
        case Difficulty::Medium: return "medium";
        case Difficulty::Hard:   return "hard";
        case Difficulty::Expert: return "expert";
    }
    return "hard";
}

inline Difficulty difficultyFromName(const std::string& text, Difficulty fallback) {
    if (text == "easy" || text == "0") return Difficulty::Easy;
    if (text == "medium" || text == "1") return Difficulty::Medium;
    if (text == "hard" || text == "2") return Difficulty::Hard;
    if (text == "expert" || text == "3") return Difficulty::Expert;
    return fallback;
}

// ─── Writing server messages ────────────────────────────────────────

// The authoritative snapshot. `seq` is monotonic per room so a client can
// throw away anything that arrives out of order after a reconnect.
inline std::string state(const Room& room, const GameState& s, unsigned long long seq) {
    std::string out;
    out.reserve(1400);

    out += "{\"type\":\"STATE\",\"room\":\"" + json::escape(room.code()) + "\"";
    out += ",\"seq\":" + std::to_string(seq);
    out += ",\"round\":{";
    out += "\"phase\":\"";
    out += roomPhaseName(room.phase());
    out += "\",\"roundNumber\":" + std::to_string(s.round.roundNumber);
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

// Full description of a room as one client sees it. `forConnId` decides who
// "you" are, so the client does not have to match ids by hand.
inline std::string room(const Room& r, int forConnId) {
    std::string out;
    out += "{\"type\":\"ROOM\",\"code\":\"" + json::escape(r.code()) + "\"";
    out += ",\"title\":\"" + json::escape(r.config().title) + "\"";
    out += ",\"phase\":\"" + std::string(roomPhaseName(r.phase())) + "\"";
    out += ",\"isHost\":" + std::string(r.isHost(forConnId) ? "true" : "false");
    out += ",\"hostId\":" + std::to_string(r.hostId());
    out += ",\"quick\":" + std::string(r.isQuickRoom() ? "true" : "false");
    out += ",\"config\":{\"roundsToWin\":" + std::to_string(r.config().roundsToWin);
    out += ",\"difficulty\":\"" + std::string(difficultyName(r.config().botDifficulty)) + "\"";
    out += ",\"humanSlots\":" + std::to_string(r.config().humanSlots) + "}";
    out += ",\"players\":[";

    const std::vector<RosterEntry>& roster = r.roster();
    for (size_t i = 0; i < roster.size(); ++i) {
        const RosterEntry& entry = roster[i];
        if (i > 0) out += ",";
        out += "{\"id\":" + std::to_string(entry.connId);
        out += ",\"session\":\"" + json::escape(entry.sessionId) + "\"";
        out += ",\"name\":\"" + json::escape(entry.name) + "\"";
        out += ",\"host\":" + std::string(r.isHost(entry.connId) ? "true" : "false");
        out += ",\"you\":" + std::string(entry.connId == forConnId ? "true" : "false");
        out += ",\"ready\":" + std::string(entry.ready ? "true" : "false");
        out += ",\"online\":" + std::string(entry.online() ? "true" : "false");
        out += ",\"ai\":" + std::string(entry.aiControlled ? "true" : "false");
        out += ",\"seat\":" + std::to_string(entry.seat);
        out += "}";
    }
    out += "],\"botSeats\":" +
           std::to_string(MAX_PLAYERS - r.seatedHumans());
    out += "}";
    return out;
}

// Public listing: enough to pick a room, nothing that identifies a player.
inline std::string roomSummary(const Room& r) {
    std::string out = "{\"code\":\"" + json::escape(r.code()) + "\"";
    out += ",\"title\":\"" + json::escape(r.config().title) + "\"";
    out += ",\"phase\":\"" + std::string(roomPhaseName(r.phase())) + "\"";
    out += ",\"players\":" + std::to_string(r.humansOnline());
    out += ",\"maxPlayers\":" + std::to_string(r.config().humanSlots);
    out += ",\"roundsToWin\":" + std::to_string(r.config().roundsToWin);
    out += ",\"difficulty\":\"" + std::string(difficultyName(r.config().botDifficulty)) + "\"";
    out += "}";
    return out;
}

inline std::string roomList(const std::vector<const Room*>& rooms) {
    std::string out = "{\"type\":\"ROOMS\",\"rooms\":[";
    for (size_t i = 0; i < rooms.size(); ++i) {
        if (i > 0) out += ",";
        out += roomSummary(*rooms[i]);
    }
    out += "]}";
    return out;
}

// Human-readable failure. `code` is a stable token for the client to branch on
// ("ROOM_NOT_FOUND"), `message` is what the player reads.
inline std::string error(const char* code, const std::string& message) {
    return "{\"type\":\"ERROR\",\"code\":\"" + std::string(code) +
           "\",\"message\":\"" + json::escape(message) + "\"}";
}

// Legacy shape, kept so older clients and the smoke test still recognise a
// refused join.
inline std::string reject(const std::string& reason) {
    return "{\"type\":\"REJECT\",\"reason\":\"" + json::escape(reason) + "\"}";
}

inline std::string welcome(int seat, const std::string& name, int maxPlayers,
                           int roundsToWin, const std::string& roomCode,
                           const std::string& sessionId) {
    std::string out = "{\"type\":\"WELCOME\",\"seat\":" + std::to_string(seat);
    out += ",\"name\":\"" + json::escape(name) + "\"";
    out += ",\"maxPlayers\":" + std::to_string(maxPlayers);
    out += ",\"wall\":\"" + std::string(GameEngine::wallName(static_cast<Wall>(seat))) + "\"";
    out += ",\"roundsToWin\":" + std::to_string(roundsToWin);
    out += ",\"startHealth\":" + std::to_string(INITIAL_HEALTH);
    out += ",\"room\":\"" + json::escape(roomCode) + "\"";
    out += ",\"sessionId\":\"" + json::escape(sessionId) + "\"";
    out += ",\"phase\":\"playing\"}";
    return out;
}

inline std::string hello(int connectionId, const std::string& sessionId) {
    return "{\"type\":\"HELLO\",\"id\":" + std::to_string(connectionId) +
           ",\"sessionId\":\"" + json::escape(sessionId) + "\"}";
}

inline std::string seatTaken(int seat, const std::string& name,
                             const std::string& roomCode) {
    std::string out = "{\"type\":\"SEATED\",\"seat\":" + std::to_string(seat);
    out += ",\"name\":\"" + json::escape(name) + "\"";
    out += ",\"wall\":\"" + std::string(GameEngine::wallName(static_cast<Wall>(seat))) + "\"";
    out += ",\"room\":\"" + json::escape(roomCode) + "\"}";
    return out;
}

inline std::string chat(const std::string& from, const std::string& text) {
    return "{\"type\":\"CHAT\",\"from\":\"" + json::escape(from) +
           "\",\"text\":\"" + json::escape(text) + "\"}";
}

inline std::string kicked(const std::string& reason) {
    return "{\"type\":\"KICKED\",\"reason\":\"" + json::escape(reason) + "\"}";
}

inline std::string notice(const std::string& text) {
    return "{\"type\":\"NOTICE\",\"text\":\"" + json::escape(text) + "\"}";
}

}  // namespace proto

#endif  // CRASHBALL_PROTOCOL_H