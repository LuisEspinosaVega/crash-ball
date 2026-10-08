// game_state.h — Crash Ball arena simulation.
//
// Design: a square arena with one wall per player. Every player slides a
// paddle along their own wall; a ball reaching a wall is either blocked by
// the paddle (and sent back faster) or gets past it, costing that player one
// health point. Last player standing wins the round; first to ROUNDS_TO_WIN
// rounds wins the match.
//
// Seats and walls are the same index, so seat 0 always owns the left wall.
//
//   seat 1 = top    (slides along x)
//   seat 0 = left   (slides along y)       seat 2 = right (slides along y)
//   seat 3 = bottom (slides along x)
//
// This engine is authoritative: clients only render what it publishes.

#ifndef CRASHBALL_GAME_STATE_H
#define CRASHBALL_GAME_STATE_H

#include <cstdint>
#include <random>
#include <string>

// ─── Tunables ──────────────────────────────────────────────────────
constexpr int MAX_PLAYERS = 4;
constexpr int MAX_BALLS = 4;
constexpr int INITIAL_HEALTH = 15;
constexpr int ROUNDS_TO_WIN = 3;

constexpr float PI_F = 3.14159265358979f;

constexpr float ARENA_HALF = 150.0f;          // playfield spans -150..150
constexpr float BALL_RADIUS = 8.0f;
constexpr float BALL_LIMIT = ARENA_HALF - BALL_RADIUS;   // where a ball rebounds

constexpr float PADDLE_HALF_LEN = 26.0f;      // half of the paddle's length
constexpr float PADDLE_HALF_THICK = 6.0f;     // half of the paddle's thickness
constexpr float PADDLE_WALL_OFFSET = ARENA_HALF - PADDLE_HALF_THICK;
constexpr float POS_LIMIT = ARENA_HALF - PADDLE_HALF_LEN;  // slide range

constexpr float PADDLE_SPEED = 420.0f;
constexpr float BALL_SPEED_BASE = 210.0f;
constexpr float BALL_SPEED_MAX = 1500.0f;
constexpr float BALL_SPEED_BOUNCE = 1.05f;    // per blocked hit
constexpr float DASH_SPEED_MULT = 3.0f;
constexpr float DASH_DURATION = 0.25f;
constexpr float DASH_COOLDOWN = 0.45f;
constexpr float DASH_PADDLE_SCALE = 1.7f;     // paddle reach while dashing
constexpr float MAX_DEFLECT = 0.9f;           // radians away from the wall normal
constexpr float ROUND_END_DELAY = 3.0f;       // result screen duration
constexpr float BALL_SPAWN_PERIOD = 18.0f;    // seconds between extra balls

enum class Wall : uint8_t { Left = 0, Top = 1, Right = 2, Bottom = 3 };
enum class Difficulty : uint8_t { Easy = 0, Medium = 1, Hard = 2, Expert = 3 };

struct PlayerState {
    int seat = 0;
    Wall wall = Wall::Left;

    bool occupied = false;
    bool isBot = false;
    std::string name;

    int hp = INITIAL_HEALTH;
    int roundsWon = 0;
    bool alive = true;

    float pos = 0.0f;    // position along this player's own wall
    float vel = 0.0f;    // slide velocity along the wall, for the client
    float x = 0.0f;      // paddle centre, arena coordinates (derived from pos)
    float y = 0.0f;
    float vx = 0.0f;     // velocity in arena coordinates (derived from vel)
    float vy = 0.0f;

    float move = 0.0f;        // held input, -1..1
    float dashTimer = 0.0f;   // > 0 while the dash window is open
    float dashCooldown = 0.0f;
    bool dashing = false;

    // Bot brain, per seat so two bots never share a reaction timer.
    float botTimer = 0.0f;
    float botTarget = 0.0f;
};

struct BallState {
    bool active = false;
    float x = 0.0f, y = 0.0f;
    float vx = 0.0f, vy = 0.0f;
};

struct RoundState {
    int roundNumber = 0;
    float gameTime = 0.0f;    // seconds
    bool roundOver = false;
    bool matchOver = false;
    int winner = -1;          // seat that won the last round, -1 = draw
    int matchWinner = -1;
    int roundsToWin = ROUNDS_TO_WIN;
    float countdown = 0.0f;   // seconds left showing the round result
    float ballTimer = 0.0f;
};

struct GameState {
    RoundState round;
    PlayerState players[MAX_PLAYERS];
    BallState balls[MAX_BALLS];
};

class GameEngine {
public:
    GameEngine();

    // ─── Match lifecycle ────────────────────────────────────────────
    //
    // A room exists before its match does: the engine stays idle in "lobby"
    // (matchStarted() == false, update() does nothing) until the host presses
    // Start, which calls startMatch().
    void startMatch(int roundsToWin);
    void stopMatch();
    bool matchStarted() const { return matchStarted_; }
    // Restarts once the match has been decided. Legacy: the R key.
    void requestRestart();

    // ─── Seats ──────────────────────────────────────────────────────
    // Seats a human. Takes a free seat, otherwise takes over a bot's seat.
    // Returns the seat index, or -1 when every seat already has a human.
    int join(const std::string& name);
    // Frees the seat entirely (the wall goes back to a fresh bot).
    void leave(int seat);
    // Hands the seat to the AI while keeping hp, score and name, so a player
    // who drops out mid-round does not simply lose the wall. Paired with
    // join(), which reclaims it when they come back.
    void hostToBot(int seat);
    // Takes a wall back from the AI. Used when a player reconnects to the room
    // they were already in. Returns false when the seat is gone or is a live
    // human's.
    bool claimSeat(int seat, const std::string& name);
    int humanSeats() const;

    void setMove(int seat, float move);
    void requestDash(int seat);
    void setBotDifficulty(Difficulty difficulty);
    // Rounds needed to win the match; mainly useful to shorten test matches.
    void setRoundsToWin(int rounds);

    void update(float dt);

    const GameState& state() const { return state_; }
    static const char* wallName(Wall wall);

private:
    GameState state_;
    Difficulty botDifficulty_ = Difficulty::Hard;
    std::mt19937 rng_;
    bool matchStarted_ = false;

    void startRound();
    void fillEmptySeatsWithBots();
    void spawnBall(int index);
    void spawnExtraBall();
    void updatePlayer(PlayerState& p, float dt);
    void updateBall(BallState& ball, float dt);
    void resolveWallHit(BallState& ball, Wall wall);
    void applyDamage(PlayerState& p, int amount);
    void checkRoundEnd();
    void botThink(PlayerState& p, float dt);
    static void syncDerived(PlayerState& p);
    static float foldAlong(float q, float limit);
    static float clampf(float v, float lo, float hi);
    static float ballSpeed(const BallState& ball);

    float frand() {
        return std::uniform_real_distribution<float>(0.0f, 1.0f)(rng_);
    }
};

#endif  // CRASHBALL_GAME_STATE_H
