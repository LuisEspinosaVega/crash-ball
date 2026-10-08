// game_state.cpp — Core Game Logic for Crash Ball

#define _USE_MATH_DEFINES
#include "game_state.h"
#include <cmath>
#include <cstring>
#include <algorithm>
#include <iostream>
#include <cstdlib>

// ─── Construction ──────────────────────────────────────────────────
// Declared in game_state.h but never defined, so CrashBallServer could
// not link (LNK2019 on GameEngine::GameEngine).

GameEngine::GameEngine() {
    // reset() parks roundNumber at 0 so the first addPlayer() starts round 1.
    reset();
}

// ─── Player Management ─────────────────────────────────────────────

uint16_t GameEngine::addPlayer(PlayerType type, const char* name) {
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        // Allow joining if slot is empty (full health, not eliminated)
        // OR if slot was eliminated (health == 0, can rejoin)
        bool isSlotAvailable = (state_.players[i].health == INITIAL_HEALTH && !state_.players[i].eliminated) ||
                               (state_.players[i].health == 0 && state_.players[i].eliminated);

        if (isSlotAvailable) {
            state_.players[i].type = type;
            state_.players[i].health = INITIAL_HEALTH;
            state_.players[i].eliminated = false;
            state_.players[i].index = i;
            state_.players[i].y = (i - 1) * 30.0f; // Y offset for each row
            if (name) strncpy(state_.players[i].name, name, 31);
            state_.players[i].name[31] = '\0';

            if (type == PlayerType::BOT) {
                botSettings_.push_back({BotSettings::Difficulty::MEDIUM});
            }

            // Reset round state if we just started
            if (state_.round.roundNumber == 0) {
                startRound();
            }

            return i;
        }
    }
    return MAX_PLAYERS; // No slots available
}

void GameEngine::setBotDifficulty(uint16_t index, BotSettings::Difficulty diff) {
    if (index < static_cast<uint16_t>(botSettings_.size())) {
        botSettings_[index].difficulty = diff;
        // Recalculate settings based on difficulty
        switch (diff) {
            case BotSettings::Difficulty::EASY:
                botSettings_[index].reactionDelay = 0.25f;
                botSettings_[index].attackCooldown = 0.8f;
                botSettings_[index].aggression = 0.3f;
                break;
            case BotSettings::Difficulty::MEDIUM:
                botSettings_[index].reactionDelay = 0.1f;
                botSettings_[index].attackCooldown = 0.5f;
                botSettings_[index].aggression = 0.5f;
                break;
            case BotSettings::Difficulty::HARD:
                botSettings_[index].reactionDelay = 0.03f;
                botSettings_[index].attackCooldown = 0.3f;
                botSettings_[index].aggression = 0.7f;
                break;
            case BotSettings::Difficulty::EXPERT:
                botSettings_[index].reactionDelay = 0.005f;
                botSettings_[index].attackCooldown = 0.2f;
                botSettings_[index].aggression = 0.9f;
                break;
        }
    }
}

// ─── Round Management ──────────────────────────────────────────────

void GameEngine::startRound() {
    // Reset players
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        state_.players[i].health = INITIAL_HEALTH;
        state_.players[i].eliminated = false;
        state_.players[i].x = static_cast<float>(i - 1.5f) * 60.0f; // Spread in center
        state_.players[i].vx = 0;
        state_.players[i].attackTimer = 0;
        state_.players[i].recoveryTimer = 0;
        state_.players[i].dashTimer = 0;
    }

    // Reset round
    state_.round.roundNumber++;
    state_.round.gameTime = 0;
    state_.round.ballCount = 1;
    state_.round.activePlayers = MAX_PLAYERS;
    state_.round.ballSpawnTimer = 3000; // Spawn next ball in 3s
    state_.round.winnerIndex = 255;

    // Spawn initial ball
    spawnBall();
}

// ─── Input Processing ──────────────────────────────────────────────

void GameEngine::processInput(uint16_t playerIndex, float deltaTime, float moveInput) {
    if (playerIndex >= MAX_PLAYERS || state_.players[playerIndex].eliminated) return;

    auto& player = state_.players[playerIndex];

    // Movement (friction arcade)
    player.vx = moveInput * PADDLE_SPEED;
    player.x += player.vx * deltaTime;

    // Clamp to arena bounds
    player.x = std::max(-ARENA_HALF + 20.0f, std::min(ARENA_HALF - 20.0f, player.x));

    // Attack cooldown
    if (player.attackTimer > 0) {
        player.attackTimer -= deltaTime;
    }

    // Recovery timer
    if (player.recoveryTimer > 0) {
        player.recoveryTimer -= deltaTime;
    }

    // Dash cooldown
    if (player.dashTimer > 0) {
        player.dashTimer -= deltaTime;
    }
}

// ─── Bot AI ────────────────────────────────────────────────────────

void GameEngine::updateBots(float deltaTime) {
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        if (state_.players[i].type != PlayerType::BOT) continue;
        if (state_.players[i].eliminated) continue;

        updateBot(i, deltaTime);
    }
}

float GameEngine::computeBotTarget(uint16_t botIndex, float deltaTime) {
    const auto& bot = state_.players[botIndex];
    const auto& settings = botSettings_[botIndex];

    // Find threatening ball
    int threatIdx = -1;
    float bestThreat = -1.0f;

    for (uint16_t b = 0; b < state_.round.ballCount; b++) {
        const auto& ball = state_.balls[b];

        // Find the bot's goal zone
        float goalX = static_cast<float>(botIndex) * ARENA_HALF * 0.4f - ARENA_HALF * 0.3f;
        float goalY = (static_cast<float>(botIndex) - 1.5f) * 30.0f;

        // Distance to goal
        float dx = ball.x - goalX;
        float dy = ball.y - goalY;
        float dist = std::sqrt(dx * dx + dy * dy);

        // Velocity toward goal
        float speedToward = ball.vx * dx + ball.vy * dy;

        if (speedToward > 0 && dist < 300.0f) {
            float timeToGoal = dist / std::max(std::abs(speedToward), 0.01f);
            float threat = 1.0f / std::max(timeToGoal, 0.1f) * std::exp(-dist / 400.0f);

            if (threat > bestThreat) {
                bestThreat = threat;
                threatIdx = b;
            }
        }
    }

    if (threatIdx >= 0) {
        const auto& ball = state_.balls[threatIdx];

        // Predict trajectory
        float t = deltaTime;
        float predictedX = ball.x + ball.vx * t;
        float predictedY = ball.y + ball.vy * t;

        // Clamp to arena bounds (simulated)
        predictedX = std::max(-ARENA_HALF, std::min(ARENA_HALF, predictedX));
        predictedY = std::max(-ARENA_HALF, std::min(ARENA_HALF, predictedY));

        // Use prediction weight to blend with current position
        float targetX = settings.predictionWeight * predictedX
                        + (1.0f - settings.predictionWeight) * ball.x;

        // Add error for difficulty-based randomness
        if (settings.difficulty != BotSettings::Difficulty::EXPERT) {
            float error = (static_cast<float>(std::rand()) / static_cast<float>(RAND_MAX) - 0.5f) * ARENA_HALF * 0.2f;
            targetX += error;
        }

        return targetX;
    }

    // Default: move toward center
    return static_cast<float>(botIndex) * 60.0f - 60.0f;
}

void GameEngine::updateBot(uint16_t botIndex, float deltaTime) {
    const auto& bot = state_.players[botIndex];
    const auto& settings = botSettings_[botIndex];

    // Reaction delay
    static float actionTimer[4] = {0};
    actionTimer[botIndex] += deltaTime;
    if (actionTimer[botIndex] < settings.reactionDelay) {
        return;
    }
    actionTimer[botIndex] = 0;

    // Find target X
    float targetX = computeBotTarget(botIndex, deltaTime);

    // Move toward target
    float dx = targetX - bot.x;
    state_.players[botIndex].vx = std::copysign(static_cast<float>(PADDLE_SPEED), dx);
    state_.players[botIndex].x += state_.players[botIndex].vx * deltaTime;

    // Clamp
    state_.players[botIndex].x = std::max(-ARENA_HALF + 20.0f, std::min(ARENA_HALF - 20.0f, state_.players[botIndex].x));

    // Attack decision
    static float attackTimer[4] = {0};
    attackTimer[botIndex] += deltaTime;

    if (attackTimer[botIndex] > settings.attackCooldown) {
        // Find nearest ball
        int nearest = -1;
        float nearestDist = 1000.0f;

        for (uint16_t b = 0; b < state_.round.ballCount; b++) {
            const auto& ball = state_.balls[b];
            float d = std::pow(ball.x - bot.x, 2) + std::pow(ball.y - bot.y, 2);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = b;
            }
        }

        // Attack if ball is close and aggression says so
        if (nearest >= 0 && nearestDist < 500.0f) {
            // Random attack decision based on aggression
            if (static_cast<float>(std::rand()) / static_cast<float>(RAND_MAX) < settings.aggression) {
                // Perform attack: multiply ball speed
                if (nearest < static_cast<int>(state_.round.ballCount)) {
                    auto& ball = state_.balls[nearest];
                    float speed = std::sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
                    float newSpeed = speed * ATTACK_SPEED_MULTIPLIER;
                    if (newSpeed < BALL_SPEED_MAX) {
                        float angle = std::atan2(ball.vy, ball.vx);
                        ball.vx = std::cos(angle) * newSpeed;
                        ball.vy = std::sin(angle) * newSpeed;
                    }
                }
            }

            attackTimer[botIndex] = 0;
            state_.players[botIndex].attackTimer = 0; // Reset attack cooldown
        } else {
            attackTimer[botIndex] = 0;
        }
    }
}

// ─── Ball Spawning ─────────────────────────────────────────────────

void GameEngine::spawnBall() {
    if (state_.round.ballCount >= 16) return;

    uint16_t newBallIdx = state_.round.ballCount++;
    auto& ball = state_.balls[newBallIdx];

    // Random position in center area
    ball.x = (std::rand() % 200) - 100.0f;
    ball.y = (std::rand() % 100) - 50.0f;

    // Random direction (away from edges)
    float angle = (std::rand() % 360) / 360.0f * 2.0f * M_PI;
    float speed = BALL_SPEED_BASE + (std::rand() % 100) * 10.0f;

    ball.vx = std::cos(angle) * speed;
    ball.vy = std::sin(angle) * speed;
    ball.type = static_cast<uint8_t>(BallType::STANDARD);
    ball.ownerIndex = 255;
    ball.speedLevel = 1;
}

// ─── Goal Updates ──────────────────────────────────────────────────

void GameEngine::updateGoals(float deltaTime) {
    // Check if any balls crossed goal lines
    for (uint16_t b = 0; b < state_.round.ballCount; b++) {
        const auto& ball = state_.balls[b];

        // Check if ball crossed any goal line
        // Goals are at x = +ARENA_HALF (right side goals for left players)
        // and x = -ARENA_HALF (left side goals for right players)

        // Right goals (players 2 and 3 defend right side)
        if (ball.x > GOAL_X && ball.y > -100 && ball.y < 100) {
            // Ball scored against player 2 or 3
            for (uint16_t p = 2; p < 4; p++) {
                if (!state_.players[p].eliminated) {
                    // Find which player owns this goal zone
                    if (ball.y < 0) {
                        // Top half - player 2
                        state_.players[2].health--;
                    } else {
                        // Bottom half - player 3
                        state_.players[3].health--;
                    }

                    if (state_.players[2].health == 0) {
                        state_.players[2].eliminated = true;
                        state_.round.activePlayers--;
                    }
                    if (state_.players[3].health == 0) {
                        state_.players[3].eliminated = true;
                        state_.round.activePlayers--;
                    }

                    // Remove ball
                    state_.round.ballCount = static_cast<uint16_t>(std::max(static_cast<int>(1), static_cast<int>(state_.round.ballCount - 1)));
                    break;
                }
            }
        }

        // Left goals (players 0 and 1 defend left side)
        if (ball.x < -GOAL_X && ball.y > -100 && ball.y < 100) {
            // Ball scored against player 0 or 1
            for (uint16_t p = 0; p < 2; p++) {
                if (!state_.players[p].eliminated) {
                    if (ball.y < 0) {
                        // Top half - player 0
                        state_.players[0].health--;
                    } else {
                        // Bottom half - player 1
                        state_.players[1].health--;
                    }

                    if (state_.players[0].health == 0) {
                        state_.players[0].eliminated = true;
                        state_.round.activePlayers--;
                    }
                    if (state_.players[1].health == 0) {
                        state_.players[1].eliminated = true;
                        state_.round.activePlayers--;
                    }

                    state_.round.ballCount = static_cast<uint16_t>(std::max(static_cast<int>(1), static_cast<int>(state_.round.ballCount - 1)));
                    break;
                }
            }
        }
    }

    // Check for round winner
    uint16_t survivors = 0;
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        if (!state_.players[i].eliminated) {
            survivors++;
        }
    }

    if (survivors <= 1) {
        state_.round.winnerIndex = 255;
        for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
            if (!state_.players[i].eliminated) {
                state_.round.winnerIndex = i;
                state_.players[i].roundsWon++;
                break;
            }
        }
    }
}

// ─── Ball Updates ──────────────────────────────────────────────────

void GameEngine::updateBalls(float deltaTime) {
    for (uint16_t b = 0; b < state_.round.ballCount; b++) {
        auto& ball = state_.balls[b];

        // Move ball
        ball.x += ball.vx * deltaTime;
        ball.y += ball.vy * deltaTime;

        // Wall collisions (top/bottom)
        if (ball.y > ARENA_HALF - 20) {
            ball.y = ARENA_HALF - 20;
            ball.vy = -std::abs(ball.vy);
        }
        if (ball.y < -ARENA_HALF + 20) {
            ball.y = -ARENA_HALF + 20;
            ball.vy = std::abs(ball.vy);
        }

        // Wall collisions (left/right) - bounce back
        if (ball.x > ARENA_HALF - 20) {
            ball.x = ARENA_HALF - 20;
            ball.vx = -std::abs(ball.vx);
        }
        if (ball.x < -ARENA_HALF + 20) {
            ball.x = -ARENA_HALF + 20;
            ball.vx = std::abs(ball.vx);
        }

        // Speed increase on wall bounce
        ball.speedLevel = static_cast<uint8_t>(ball.speedLevel + 1 < 10 ? ball.speedLevel + 1 : 10);
    }
}

// ─── Collision Detection ───────────────────────────────────────────

void GameEngine::checkBallCollisions() {
    for (uint16_t b = 0; b < state_.round.ballCount; b++) {
        auto& ball = state_.balls[b];

        // Check paddle collisions
        for (uint16_t p = 0; p < MAX_PLAYERS; p++) {
            if (state_.players[p].eliminated) continue;

            const auto& player = state_.players[p];

            // Simple distance check
            float dx = ball.x - player.x;
            float dy = ball.y - player.y;
            float dist = std::sqrt(dx * dx + dy * dy);

            if (dist < PADDLE_RADIUS + BALL_RADIUS) {
                // Collision detected!
                // Reflect ball based on contact point
                float angle = std::atan2(dy, dx);
                float hitFactor = std::min(std::fabs(angle) / (static_cast<float>(M_PI) / 2.0f), static_cast<float>(1.0f)); // 0 = center, 1 = edges

                // Calculate reflection
                float newVx = -ball.vx + std::cos(angle) * 100.0f;
                float newVy = -ball.vy + std::sin(angle) * 100.0f;

                // Speed increase
                float speed = std::sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
                float newSpeed = std::min(std::sqrt(newVx * newVx + newVy * newVy), BALL_SPEED_MAX);

                // Normalize and scale
                float norm = std::sqrt(newVx * newVx + newVy * newVy);
                if (norm > 0) {
                    ball.vx = (newVx / norm) * newSpeed;
                    ball.vy = (newVy / norm) * newSpeed;
                }

                // Move ball out of paddle
                ball.x += (ball.x > player.x ? 1.0f : -1.0f) * (PADDLE_RADIUS + BALL_RADIUS - dist);

                // Apply speed level
                ball.speedLevel = static_cast<uint8_t>(ball.speedLevel + 1 < 10 ? ball.speedLevel + 1 : 10);
            }
        }
    }
}

void GameEngine::checkPaddleCollisions() {
    // Check paddle-paddle collisions
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        for (uint16_t j = i + 1; j < MAX_PLAYERS; j++) {
            const auto& p1 = state_.players[i];
            const auto& p2 = state_.players[j];

            float dx = p2.x - p1.x;
            float dy = p2.y - p1.y;
            float dist = std::sqrt(dx * dx + dy * dy);

            if (dist < PADDLE_RADIUS * 2) {
                // Push apart
                float nx = dx / dist;
                float ny = dy / dist;
                state_.players[i].x -= nx * 0.5f;
                state_.players[j].x += nx * 0.5f;
            }
        }
    }
}

// ─── Main Update ───────────────────────────────────────────────────

void GameEngine::update(float deltaTime) {
    // Update game time
    state_.round.gameTime += static_cast<uint16_t>(deltaTime * 1000);

    // Spawn new balls over time
    state_.round.ballSpawnTimer -= static_cast<uint16_t>(deltaTime * 1000);
    if (state_.round.ballSpawnTimer <= 0 && state_.round.ballCount < 8) {
        // Spawn a ball based on game progress
        if (state_.round.ballCount < 4) {
            state_.round.ballSpawnTimer = 3000;
        } else {
            state_.round.ballSpawnTimer = 2000;
        }
        if (std::rand() % 100 < 50) {
            spawnBall();
        }
    }

    // Update physics
    updateBalls(deltaTime);
    checkPaddleCollisions();
    updateGoals(deltaTime);

    // Check for round end
    uint16_t survivors = 0;
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        if (!state_.players[i].eliminated) {
            survivors++;
        }
    }

    if (survivors <= 1 || state_.round.activePlayers <= 1) {
        state_.round.winnerIndex = 255;
        for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
            if (!state_.players[i].eliminated) {
                state_.round.winnerIndex = i;
                state_.players[i].roundsWon++;
                break;
            }
        }
    }
}

// ─── BotSettings static helper ────────────────────────────────────

BotSettings BotSettings::defaultSettings() {
    BotSettings s;
    s.difficulty = Difficulty::MEDIUM;
    s.reactionDelay = 0.1f;
    s.attackCooldown = 0.5f;
    s.aggression = 0.5f;
    s.predictionWeight = 0.5f;
    s.errorMargin = 0.2f;
    return s;
}

// ─── Reset ─────────────────────────────────────────────────────────

void GameEngine::reset() {
    state_.round.roundNumber = 0;
    state_.round.activePlayers = 0;
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        state_.players[i].health = INITIAL_HEALTH;
        state_.players[i].eliminated = false;
    }
}
