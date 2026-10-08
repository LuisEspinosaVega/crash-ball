// game_state.h — Core Game State Management for Crash Ball

#ifndef GAME_STATE_H
#define GAME_STATE_H

#include "network.h"
#include <array>
#include <vector>
#include <cstdint>
#include <cmath>

// ─── Constants ─────────────────────────────────────────────────────
constexpr uint16_t MAX_PLAYERS = 4;
constexpr uint16_t INITIAL_HEALTH = 15;
constexpr uint16_t HEALTH_PER_POINT = 1;
constexpr uint16_t ROUNDS_TO_WIN = 3;
constexpr float BALL_SPEED_BASE = 200.0f;
constexpr float BALL_SPEED_MULTIPLIER = 1.05f;
constexpr float BALL_SPEED_MAX = 1500.0f;
constexpr float ATTACK_SPEED_MULTIPLIER = 3.0f;
constexpr float PADDLE_SPEED = 400.0f;
constexpr float ATTACK_COOLDOWN = 0.45f;
constexpr float ATTACK_RECOVERY = 0.25f;
constexpr float ARENA_HALF = 150.0f;
constexpr float PADDLE_RADIUS = 15.0f;
constexpr float BALL_RADIUS = 8.0f;
constexpr float GOAL_X = ARENA_HALF * 0.85f;

// ─── Player State ──────────────────────────────────────────────────

enum class PlayerType : uint8_t { HUMAN, BOT };

struct PlayerState {
    uint16_t index = 0;
    PlayerType type = PlayerType::HUMAN;
    uint16_t health = INITIAL_HEALTH;
    uint16_t roundsWon = 0;
    bool     eliminated = false;
    float    x = 0;
    float    vx = 0;
    float    vy = 0;
    float    y = 0;
    float    attackTimer = 0;
    float    recoveryTimer = 0;
    float    dashTimer = 0;
    char     name[32];
};

// ─── Ball State ────────────────────────────────────────────────────

struct BallState {
    float x = 0;
    float y = 0;
    float vx = 0;
    float vy = 0;
    uint8_t type = static_cast<uint8_t>(BallType::STANDARD);
    uint8_t ownerIndex = 255;
    uint8_t speedLevel = 1;
};

// ─── Round State ───────────────────────────────────────────────────

struct RoundState {
    uint16_t roundNumber = 1;
    uint16_t gameTime = 0;
    uint16_t ballCount = 1;
    uint16_t activePlayers = MAX_PLAYERS;
    uint16_t ballSpawnTimer = 0;
    uint16_t roundDuration = 0;
    uint16_t winnerIndex = 255;
};

// ─── Full Game State ───────────────────────────────────────────────

struct GameState {
    RoundState round;
    PlayerState players[MAX_PLAYERS];
    BallState balls[16];
};

// ─── Bot AI Settings ──────────────────────────────────────────────

struct BotSettings {
    enum class Difficulty : uint8_t {
        EASY, MEDIUM, HARD, EXPERT
    };
    Difficulty difficulty = Difficulty::MEDIUM;
    float reactionDelay = 0.1f;
    float attackCooldown = 0.5f;
    float aggression = 0.5f;
    float predictionWeight = 0.5f;
    float errorMargin = 0.2f;

    static BotSettings defaultSettings();
};

// ─── Game Engine API ───────────────────────────────────────────────

class GameEngine {
public:
    GameEngine();

    uint16_t addPlayer(PlayerType type, const char* name);
    void setBotDifficulty(uint16_t index, BotSettings::Difficulty diff);
    void startRound();
    void processInput(uint16_t playerIndex, float deltaTime, float moveInput);
    void updateBots(float deltaTime);
    void update(float deltaTime);
    const GameState& getState() const { return state_; }
    uint16_t getActivePlayers() const { return state_.round.activePlayers; }
    uint16_t getRoundNumber() const { return state_.round.roundNumber; }
    uint16_t getGameTime() const { return state_.round.gameTime; }
    bool isEliminated(uint16_t index) const {
        return state_.players[index].eliminated;
    }
    GameState& getMutableState() { return state_; }
    bool isRoundOver() const;
    uint16_t getWinner() const { return state_.round.winnerIndex; }
    void reset();

private:
    GameState state_;
    std::vector<BotSettings> botSettings_;

    void updateBalls(float deltaTime);
    void spawnBall();
    void updateGoals(float deltaTime);
    void checkBallCollisions();
    void checkPaddleCollisions();

    void updateBot(uint16_t playerIndex, float deltaTime);
    float computeBotTarget(uint16_t botIndex, float deltaTime);
};

#endif // GAME_STATE_H
