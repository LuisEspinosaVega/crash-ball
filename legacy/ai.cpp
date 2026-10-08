// ai.cpp — AI Implementation for Crash Ball Bots

#include "ai.h"
#include <algorithm>
#include <cmath>
#include <random>
#include <vector>

// ─── Bot Settings ──────────────────────────────────────────────────

void BotBrain::setDifficulty(BotSettings::Difficulty diff) {
    settings_ = BotSettings::defaultSettings();
    settings_.difficulty = diff;
}

// ─── Predict Ball Trajectory ───────────────────────────────────────

BotBrain::Trajectory BotBrain::predictBallTrajectory(const BallState& ball,
                                                        const PlayerState& target,
                                                        float deltaTime) const
{
    // Simple trajectory prediction: extrapolate where the ball will be
    float t = deltaTime; // Predict for a short time window

    // Find walls/balls and simulate
    float x = ball.x;
    float y = ball.y;
    float vx = ball.vx;
    float vy = ball.vy;

    // Simple prediction: where will the ball be in ~0.5 seconds?
    // This assumes no complex bounces for now
    float predictedX = x + vx * t;
    float predictedY = y + vy * t;

    // Clamp to arena bounds (simulated)
    predictedX = std::max(-ARENA_HALF, std::min(ARENA_HALF, predictedX));
    predictedY = std::max(-ARENA_HALF, std::min(ARENA_HALF, predictedY));

    return {predictedX, predictedY, vx, vy, t};
}

// ─── Find Most Threatening Ball ────────────────────────────────────

int BotBrain::findThreateningBall(const GameState& state) const {
    int bestIdx = -1;
    float bestThreat = -1.0f;

    for (int i = 0; i < state.round.ballCount; i++) {
        const auto& ball = state.balls[i];

        // Check if ball is heading toward our goal area
        // Each player has a goal zone based on their seat
        float goalX = static_cast<float>(index_) * ARENA_HALF * 0.4f - ARENA_HALF * 0.2f;
        float goalY = -ARENA_HALF * 0.3f; // Back area of arena

        // Distance from ball to our goal
        float dx = ball.x - goalX;
        float dy = ball.y - goalY;
        float dist = std::sqrt(dx * dx + dy * dy);

        // Velocity toward goal
        float speedTowardGoal = 
            (ball.vx * dx + ball.vy * dy) / std::max(std::abs(ball.vx), 0.01f);

        if (speedTowardGoal > 0 && dist < 200.0f) {
            // Time to reach goal (lower is more threatening)
            float timeToGoal = dist / std::max(std::abs(speedTowardGoal), 0.01f);

            // Threat = 1/timeToGoal (higher = more urgent)
            // Penalize balls that are very far
            float threat = 1.0f / std::max(timeToGoal, 0.1f) * std::exp(-dist / 300.0f);

            if (threat > bestThreat) {
                bestThreat = threat;
                bestIdx = i;
            }
        }
    }

    return bestIdx;
}

// ─── Compute Optimal X Position ────────────────────────────────────

float BotBrain::computeOptimalX(const GameState& state) const {
    const int threatIdx = findThreateningBall(state);

    if (threatIdx < 0) {
        // No threatening ball - move to center of own zone
        float center = static_cast<float>(index_) * ARENA_HALF * 0.4f;
        return center + rng_() * settings_.errorMargin * ARENA_HALF;
    }

    const auto& ball = state.balls[threatIdx];

    // Predict where the ball will be
    BotSettings defaultSettings = BotSettings::defaultSettings();
    BotSettings emptySettings;
    emptySettings.difficulty = BotSettings::Difficulty::MEDIUM;
    PlayerState emptyPlayer;
    emptyPlayer.type = PlayerType::HUMAN;

    auto trajectory = predictBallTrajectory(ball, emptyPlayer, 0.5f);

    // Use prediction weight to blend with simple tracking
    float predictedX = trajectory.x;
    float simpleTarget = ball.x; // Just follow the ball

    float optimalX = settings_.predictionWeight * predictedX 
                     + (1.0f - settings_.predictionWeight) * simpleTarget;

    // Add error for difficulty-based randomness
    optimalX += settings_.errorMargin * ARENA_HALF * 
                static_cast<float>(rng_() % 100) / 100.0f - 0.5f;

    return optimalX;
}

// ─── Decide Whether to Attack ─────────────────────────────────────

bool BotBrain::decideAttack(const GameState& state) const {
    // Only attack if there's a threatening ball AND we're close enough
    int threatIdx = findThreateningBall(state);

    if (threatIdx < 0) {
        // Random small chance to attack (aggression-based)
        return static_cast<bool>(rng_() % 100) < static_cast<int>(settings_.aggression * 100);
    }

    const auto& ball = state.balls[threatIdx];

    // Distance to ball
    float dist = std::sqrt(std::pow(ball.x - 0.0f, 2) + std::pow(ball.y, 2));

    // Attack if ball is close enough and we have cooldown
    return dist < 20.0f && static_cast<float>(rng_() % 100) < static_cast<int>(settings_.aggression * 100);
}

// ─── Main Action Computation ───────────────────────────────────────

BotBrain::Action BotBrain::computeAction(const GameState& state, float deltaTime) {
    static constexpr float MOVE_SPEED = 300.0f;

    // Apply reaction delay
    static float actionTimer = 0;
    actionTimer += deltaTime;
    if (actionTimer < settings_.reactionDelay) {
        // Still waiting
        return {0, false, 0};
    }
    actionTimer = 0;

    // Find threatening ball
    int threatIdx = findThreateningBall(state);

    float targetX;
    bool attack = false;
    float attackAngle = 0;

    if (threatIdx >= 0) {
        const auto& ball = state.balls[threatIdx];

        // Compute optimal x position
        targetX = computeOptimalX(state);

        // Decide whether to attack
        attack = decideAttack(state);

        // Compute attack angle (toward the ball)
        if (attack) {
            attackAngle = std::atan2(ball.y, ball.x);
        }
    } else {
        // No threat - move to center of own zone
        targetX = static_cast<float>(index_) * ARENA_HALF * 0.4f;
    }

    return {targetX, attack, attackAngle};
}

void BotBrain::reset() {
    // Reset any per-round state
}
