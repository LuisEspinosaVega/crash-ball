// room.h — A match waiting to happen.
//
// The server used to hold exactly one GameEngine that everybody joined. That
// makes "play with a friend" impossible: whoever connects first owns the
// walls. A Room is the unit of matchmaking now: it owns a lobby roster, a host,
// a configuration, a share code and a phase.
//
// Locking
// -------
// This class owns no locking of its own, on purpose, so the two locks in the
// server never have to nest:
//
//   * `phase_` is atomic: the game loop reads it every tick.
//   * everything else (roster, host, config) is guarded by the server's single
//     lobby mutex.
//   * the simulation is never touched from here. Seating a player, starting a
//     match and releasing walls all happen in server.cpp under the engine's own
//     mutex, so a room cannot accidentally mutate state while it is running.

#ifndef CRASHBALL_ROOM_H
#define CRASHBALL_ROOM_H

#include "game_state.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

enum class RoomPhase {
    Lobby,      // waiting for the host to press Start
    Playing,    // match in progress
    Finished    // match decided: rematch, or back to the lobby
};

inline const char* roomPhaseName(RoomPhase phase) {
    switch (phase) {
        case RoomPhase::Lobby:    return "lobby";
        case RoomPhase::Playing:  return "playing";
        case RoomPhase::Finished: return "finished";
    }
    return "lobby";
}

struct RoomConfig {
    std::string title = "Sala";
    int roundsToWin = ROUNDS_TO_WIN;
    Difficulty botDifficulty = Difficulty::Hard;
    int humanSlots = MAX_PLAYERS;  // humans admitted before the room is full
    bool isQuickRoom = false;      // the implicit "Jugar rapido" match
};

// One human, remembered across reconnects by `sessionId`. The entry outlives
// the socket: a player who drops out keeps their name, their score and (while
// the grace window lasts) their wall, played by the AI.
struct RosterEntry {
    int connId = -1;            // live connection, -1 while the player is away
    std::string sessionId;      // stable identity across reconnects
    std::string name;
    bool ready = false;
    bool aiControlled = false;  // their seat is on autopilot right now
    int seat = -1;              // engine seat, -1 while in the lobby
    int64_t offlineSinceMs = 0;
    bool online() const { return connId >= 0; }
};

class Room {
public:
    explicit Room(std::string code, RoomConfig config)
        : code_(std::move(code)), config_(std::move(config)) {}

    Room(const Room&) = delete;
    Room& operator=(const Room&) = delete;

    const std::string& code() const { return code_; }
    bool isQuickRoom() const { return config_.isQuickRoom; }

    RoomPhase phase() const { return phase_.load(std::memory_order_relaxed); }
    void setPhase(RoomPhase phase) { phase_.store(phase, std::memory_order_relaxed); }

    // ─── Configuration ─────────────────────────────────────────────
    //
    // The caller must have told the engine about the change already; this only
    // records it for the lobby UI and for the next startMatch().

    const RoomConfig& config() const { return config_; }
    void setConfig(const RoomConfig& config) { config_ = config; }

    bool hasFreeSlot() const { return humansOnline() < config_.humanSlots; }

    // ─── Simulation ────────────────────────────────────────────────
    //
    // The room owns the engine but never touches it: server.cpp does that under
    // engineMutex(), so a message handler cannot collide with the game loop
    // through a helper that forgot to lock.

    GameEngine& engine() { return engine_; }
    const GameEngine& engine() const { return engine_; }
    std::mutex& engineMutex() { return engineMutex_; }

    // ─── Roster ────────────────────────────────────────────────────

    int humansOnline() const {
        int count = 0;
        for (const RosterEntry& entry : roster_) {
            if (entry.online()) ++count;
        }
        return count;
    }

    int rosterSize() const { return static_cast<int>(roster_.size()); }
    const std::vector<RosterEntry>& roster() const { return roster_; }
    std::vector<RosterEntry>& rosterRef() { return roster_; }

    // Humans currently holding a wall (online or on autopilot).
    int seatedHumans() const {
        int count = 0;
        for (const RosterEntry& entry : roster_) {
            if (entry.seat >= 0) ++count;
        }
        return count;
    }

    RosterEntry* findByConn(int connId) {
        for (RosterEntry& entry : roster_) {
            if (entry.online() && entry.connId == connId) return &entry;
        }
        return nullptr;
    }

    RosterEntry* findBySession(const std::string& sessionId) {
        if (sessionId.empty()) return nullptr;
        for (RosterEntry& entry : roster_) {
            if (entry.sessionId == sessionId) return &entry;
        }
        return nullptr;
    }

    RosterEntry* findBySeat(int seat) {
        for (RosterEntry& entry : roster_) {
            if (entry.seat == seat) return &entry;
        }
        return nullptr;
    }

    RosterEntry& addMember(int connId, std::string sessionId,
                           const std::string& name) {
        RosterEntry entry;
        entry.connId = connId;
        entry.sessionId = std::move(sessionId);
        entry.name = name;
        roster_.push_back(std::move(entry));
        if (hostConnId_ < 0) hostConnId_ = connId;
        return roster_.back();
    }

    // Removes the live entry for a connection. Entries for players who merely
    // dropped are kept (see markOffline) so they can reclaim their seat.
    void removeMember(int connId) {
        roster_.erase(std::remove_if(roster_.begin(), roster_.end(),
                                     [connId](const RosterEntry& e) {
                                         return e.online() && e.connId == connId;
                                     }),
                      roster_.end());
        if (hostConnId_ == connId) promoteHost();
    }

    void markOffline(RosterEntry& entry, int64_t nowMs) {
        entry.connId = -1;
        entry.offlineSinceMs = nowMs;
        entry.ready = false;
        if (entry.seat >= 0) entry.aiControlled = true;
    }

    // Drops entries that were offline past the grace window and returns the
    // seats they were holding, so the caller can release them to the AI.
    std::vector<int> pruneOffline(int64_t nowMs, int64_t graceMs) {
        std::vector<int> freed;
        std::vector<RosterEntry> kept;
        kept.reserve(roster_.size());
        for (RosterEntry& entry : roster_) {
            const bool expired = !entry.online() && entry.offlineSinceMs > 0 &&
                                 (nowMs - entry.offlineSinceMs) > graceMs;
            if (expired) {
                if (entry.seat >= 0) freed.push_back(entry.seat);
            } else {
                kept.push_back(entry);
            }
        }
        if (freed.empty() && kept.size() == roster_.size()) return freed;
        roster_.swap(kept);
        promoteHost();
        return freed;
    }

    // ─── Host ──────────────────────────────────────────────────────

    int hostId() const { return hostConnId_; }
    bool isHost(int connId) const { return hostConnId_ == connId; }

    void promoteHost() {
        hostConnId_ = -1;
        for (const RosterEntry& entry : roster_) {
            if (entry.online()) {
                hostConnId_ = entry.connId;
                return;
            }
        }
    }

private:
    std::string code_;
    RoomConfig config_;
    std::atomic<RoomPhase> phase_{RoomPhase::Lobby};
    std::vector<RosterEntry> roster_;
    int hostConnId_ = -1;

    GameEngine engine_;
    std::mutex engineMutex_;
};

// ─── Share codes ───────────────────────────────────────────────────
//
// Meant to be read out loud, so no 0/O and no 1/I: what you read is what you
// type. 32 symbols, 5 characters, ~33 million combinations.
inline std::string makeRoomCode(std::uint64_t& seed) {
    static const char kAlphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    std::string code;
    for (int i = 0; i < 5; ++i) {
        // xorshift64*, so two seeds that happen to be close cannot produce the
        // same sequence of codes.
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        const std::uint64_t r = seed * 0x2545F4914F6CDD1DULL;
        code.push_back(kAlphabet[r % 32]);
    }
    return code;
}

// Uppercases and keeps the characters the alphabet is actually made of:
// A-Z plus 2-9. Digits matter: dropping them here would make a code like
// "3EFQP" impossible to join.
inline std::string normalizeCode(const std::string& raw) {
    std::string code;
    code.reserve(raw.size());
    for (char c : raw) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
        if ((c >= 'A' && c <= 'Z') || (c >= '2' && c <= '9')) code.push_back(c);
    }
    return code;
}

#endif  // CRASHBALL_ROOM_H