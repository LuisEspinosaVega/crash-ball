// ai.h — Intelligent Bot System for Crash Ball
// Predictive AI with difficulty levels

#pragma once

#include "game_state.h"
#include <array>
#include <cmath>
#include <random>

// Bot brain with predictive tracking
class BotBrain {
public:
    BotBrain(uint16_t index, uint8_t seed)
        : index_(index), rng_(seed), settings_(BotSettings::defaultSettings()) {}

    // Set difficulty and recalculate settings
    void setDifficulty(BotSettings::Difficulty diff);

    // Get current action for this bot (called every tick)
    // Returns: target x position to move toward, and whether to attack
    struct Action {
        float targetX;      // Where the bot wants to be
        bool  attack;       // Whether to use dash/attack
        float attackAngle;  // Direction of attack (if attacking)
    };

    Action computeAction(const GameState& state, float deltaTime);

    // Get the bot's player state
    uint16_t index() const { return index_; }
    BotSettings::Difficulty difficulty() const { return settings_.difficulty; }

    // Reset for a new round
    void reset();

    // Get reaction delay in milliseconds
    int reactionDelayMs() const { return static_cast<int>(settings_.reactionDelay * 1000); }

private:
    uint16_t index_;
    mutable std::mt19937 rng_;
    BotSettings settings_;

    // Predictive tracking
    struct Trajectory {
        float x, y;
        float vx, vy;
        float timeToGoal;  // Seconds to reach the goal area
    };

    Trajectory predictBallTrajectory(const BallState& ball,
                                     const PlayerState& targetPlayer,
                                     float deltaTime) const;

    // Find the most threatening ball
    int findThreateningBall(const GameState& state) const;

    // Compute the optimal x position based on ball trajectory
    float computeOptimalX(const GameState& state) const;

    // Decide whether to attack based on timing
    bool decideAttack(const GameState& state) const;
};
