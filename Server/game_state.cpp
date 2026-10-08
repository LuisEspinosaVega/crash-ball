// game_state.cpp — Crash Ball arena simulation.

#include "game_state.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace {

// Per-difficulty bot personality: reaction delay in seconds, aim jitter in
// world units, and how often the bot chooses to dash.
struct BotPreset {
    float reaction;
    float error;
    float aggression;
};

const BotPreset kPresets[4] = {
    {0.26f, 55.0f, 0.30f},  // Easy
    {0.11f, 26.0f, 0.55f},  // Medium
    {0.04f, 9.0f, 0.75f},   // Hard
    {0.01f, 2.5f, 0.92f},   // Expert
};

const char* kBotNames[MAX_PLAYERS] = {
    "Bot Cian", "Bot Rosa", "Bot Morado", "Bot Verde",
};

}  // namespace

// ─── Helpers ───────────────────────────────────────────────────────

float GameEngine::clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

float GameEngine::ballSpeed(const BallState& ball) {
    return std::sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
}

// Folds an unbounded coordinate into [-limit, limit] using the triangle wave a
// bouncing ball traces. Used by the bots to predict where a shot will land
// after however many wall rebounds happen on the way.
float GameEngine::foldAlong(float q, float limit) {
    const float period = 4.0f * limit;
    float m = std::fmod(q + limit, period);
    if (m < 0.0f) m += period;
    const float d = (m < 2.0f * limit) ? m : (period - m);
    return d - limit;
}

const char* GameEngine::wallName(Wall wall) {
    switch (wall) {
        case Wall::Left:   return "left";
        case Wall::Top:    return "top";
        case Wall::Right:  return "right";
        case Wall::Bottom: return "bottom";
    }
    return "left";
}

// Projects the slide position onto arena coordinates so clients can render the
// paddle without knowing anything about wall orientation.
void GameEngine::syncDerived(PlayerState& p) {
    const bool vertical = (p.wall == Wall::Left || p.wall == Wall::Right);

    if (vertical) {
        p.x = (p.wall == Wall::Left ? -1.0f : 1.0f) * PADDLE_WALL_OFFSET;
        p.y = p.pos;
        p.vx = 0.0f;
        p.vy = p.vel;
    } else {
        p.y = (p.wall == Wall::Top ? 1.0f : -1.0f) * PADDLE_WALL_OFFSET;
        p.x = p.pos;
        p.vx = p.vel;
        p.vy = 0.0f;
    }
}

// ─── Lifecycle ─────────────────────────────────────────────────────

GameEngine::GameEngine()
    : rng_(static_cast<std::mt19937::result_type>(
          std::chrono::steady_clock::now().time_since_epoch().count())) {
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        state_.players[i].seat = i;
        state_.players[i].wall = static_cast<Wall>(i);
    }
    // Start with a full set of bots so the arena is alive before anyone joins.
    fillEmptySeatsWithBots();
    startRound();
}

// ─── Match lifecycle ───────────────────────────────────────────────

void GameEngine::startMatch(int roundsToWin) {
    setRoundsToWin(roundsToWin);
    state_.round.matchOver = false;
    state_.round.matchWinner = -1;
    state_.round.roundNumber = 0;   // startRound() bumps it to 1
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        state_.players[i].roundsWon = 0;
    }
    matchStarted_ = true;
    startRound();
}

void GameEngine::stopMatch() {
    // The room goes back to its lobby: humans lose their walls, the bots take
    // over again and the engine stops simulating until the host starts a new
    // match.
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        PlayerState& p = state_.players[i];
        if (p.occupied && !p.isBot) {
            p.occupied = false;
            p.isBot = false;
            p.name.clear();
            p.move = 0.0f;
            p.dashTimer = 0.0f;
            p.dashing = false;
        }
    }
    matchStarted_ = false;
    state_.round.matchOver = false;
    state_.round.matchWinner = -1;
    state_.round.roundOver = false;
    state_.round.countdown = 0.0f;
    fillEmptySeatsWithBots();
}

void GameEngine::requestRestart() {
    if (!matchStarted_ || !state_.round.matchOver) return;
    startMatch(state_.round.roundsToWin);
}

void GameEngine::fillEmptySeatsWithBots() {
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        PlayerState& p = state_.players[i];
        p.seat = i;
        p.wall = static_cast<Wall>(i);
        if (!p.occupied) {
            p.occupied = true;
            p.isBot = true;
            p.name = kBotNames[i];
        }
    }
}

int GameEngine::join(const std::string& name) {
    int seat = -1;

    // A genuinely free seat first.
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        if (!state_.players[i].occupied) {
            seat = i;
            break;
        }
    }
    // Otherwise take over a bot.
    if (seat < 0) {
        for (int i = 0; i < MAX_PLAYERS; ++i) {
            if (state_.players[i].isBot) {
                seat = i;
                break;
            }
        }
    }
    if (seat < 0) return -1;   // four humans already playing

    PlayerState& p = state_.players[seat];
    p.occupied = true;
    p.isBot = false;
    p.seat = seat;
    p.wall = static_cast<Wall>(seat);
    p.name = name.empty() ? ("Jugador " + std::to_string(seat + 1)) : name;
    p.move = 0.0f;

    // Late joiners enter the current round at full health. During the result
    // screen they simply wait for the next round to reset them.
    if (!state_.round.roundOver && !state_.round.matchOver) {
        p.hp = INITIAL_HEALTH;
        p.alive = true;
    }
    return seat;
}

void GameEngine::leave(int seat) {
    if (seat < 0 || seat >= MAX_PLAYERS) return;
    PlayerState& p = state_.players[seat];
    if (p.isBot) return;   // bots are not owned by a connection

    p.occupied = false;
    p.isBot = false;
    p.name.clear();
    p.move = 0.0f;
    p.dashTimer = 0.0f;
    p.dashing = false;

    // Hand the wall straight back to a bot so nobody's flank is left open.
    fillEmptySeatsWithBots();
}

// A player who drops mid-round keeps their wall, their health and their score:
// the AI simply plays it until they reconnect. Losing a wall because a network
// hiccupped is the fastest way to make an online game feel unfair.
void GameEngine::hostToBot(int seat) {
    if (seat < 0 || seat >= MAX_PLAYERS) return;
    PlayerState& p = state_.players[seat];
    if (!p.occupied) return;

    p.isBot = true;
    p.move = 0.0f;
    p.dashTimer = 0.0f;
    p.dashing = false;
    p.botTimer = 0.0f;
}

int GameEngine::humanSeats() const {
    int count = 0;
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        const PlayerState& p = state_.players[i];
        if (p.occupied && !p.isBot) ++count;
    }
    return count;
}

bool GameEngine::claimSeat(int seat, const std::string& name) {
    if (seat < 0 || seat >= MAX_PLAYERS) return false;
    PlayerState& p = state_.players[seat];
    if (!p.occupied) return false;
    if (!p.isBot) return false;   // somebody live already owns it

    p.isBot = false;
    p.name = name.empty() ? p.name : name;
    p.move = 0.0f;
    p.botTimer = 0.0f;
    p.botTarget = 0.0f;
    return true;
}

void GameEngine::setBotDifficulty(Difficulty difficulty) {
    botDifficulty_ = difficulty;
}

void GameEngine::setRoundsToWin(int rounds) {
    if (rounds < 1) rounds = 1;
    if (rounds > 9) rounds = 9;
    state_.round.roundsToWin = rounds;

    // The target changed, so "match decided" has to be recomputed against it.
    state_.round.matchWinner = -1;
    state_.round.matchOver = false;
    for (int i = 0; i < MAX_PLAYERS; ++i) {
        if (state_.players[i].roundsWon >= rounds) {
            state_.round.matchWinner = i;
        }
    }
}

// ─── Commands from clients ─────────────────────────────────────────

void GameEngine::setMove(int seat, float move) {
    if (seat < 0 || seat >= MAX_PLAYERS) return;
    PlayerState& p = state_.players[seat];
    if (!p.occupied || p.isBot) return;
    p.move = clampf(move, -1.0f, 1.0f);
}

void GameEngine::requestDash(int seat) {
    if (seat < 0 || seat >= MAX_PLAYERS) return;
    PlayerState& p = state_.players[seat];
    if (!p.occupied || !p.alive) return;
    if (p.dashCooldown > 0.0f) return;
    if (state_.round.roundOver || state_.round.matchOver) return;

    p.dashTimer = DASH_DURATION;
    p.dashCooldown = DASH_COOLDOWN;
    p.dashing = true;
}

// ─── Round flow ────────────────────────────────────────────────────

void GameEngine::startRound() {
    fillEmptySeatsWithBots();

    state_.round.roundNumber++;
    state_.round.gameTime = 0.0f;
    state_.round.roundOver = false;
    state_.round.winner = -1;
    state_.round.countdown = 0.0f;
    state_.round.ballTimer = 0.0f;
    // round.matchWinner / round.matchOver are deliberately preserved: a new
    // round inside a match must not erase "this match is decided".

    for (int i = 0; i < MAX_PLAYERS; ++i) {
        PlayerState& p = state_.players[i];
        p.seat = i;
        p.wall = static_cast<Wall>(i);
        p.hp = INITIAL_HEALTH;
        p.alive = true;      // roundsWon persists across rounds on purpose
        p.pos = 0.0f;
        p.vel = 0.0f;
        p.move = 0.0f;
        p.dashTimer = 0.0f;
        p.dashCooldown = 0.0f;
        p.dashing = false;
        p.botTimer = 0.0f;
        p.botTarget = 0.0f;
        syncDerived(p);
    }

    for (int i = 0; i < MAX_BALLS; ++i) {
        state_.balls[i] = BallState();
    }
    spawnBall(0);
}

void GameEngine::spawnBall(int index) {
    if (index < 0 || index >= MAX_BALLS) return;

    BallState& ball = state_.balls[index];

    // Launch from a spot that is not already occupied by a ball in play;
    // without this, extra balls appear stacked on top of an existing one.
    constexpr float kClearance = BALL_RADIUS * 6.0f;
    float bx = 0.0f;
    float by = 0.0f;

    for (int attempt = 0; attempt < 12; ++attempt) {
        bx = (frand() * 2.0f - 1.0f) * 45.0f;
        by = (frand() * 2.0f - 1.0f) * 45.0f;

        bool clear = true;
        for (int i = 0; i < MAX_BALLS; ++i) {
            if (i == index || !state_.balls[i].active) continue;
            const float dx = state_.balls[i].x - bx;
            const float dy = state_.balls[i].y - by;
            if (dx * dx + dy * dy < kClearance * kClearance) {
                clear = false;
                break;
            }
        }
        if (clear) break;
    }

    // Avoid an almost axis-aligned launch, which would let the ball graze
    // along one pair of walls instead of crossing the arena.
    float angle = PI_F * 0.25f;
    for (int attempt = 0; attempt < 8; ++attempt) {
        const float candidate = frand() * 2.0f * PI_F;
        if (std::fabs(std::cos(candidate)) > 0.28f &&
            std::fabs(std::sin(candidate)) > 0.28f) {
            angle = candidate;
            break;
        }
    }

    ball.active = true;
    ball.x = bx;
    ball.y = by;
    ball.vx = std::cos(angle) * BALL_SPEED_BASE;
    ball.vy = std::sin(angle) * BALL_SPEED_BASE;
}

void GameEngine::spawnExtraBall() {
    for (int i = 0; i < MAX_BALLS; ++i) {
        if (!state_.balls[i].active) {
            spawnBall(i);
            return;
        }
    }
}

// ─── Simulation ────────────────────────────────────────────────────

void GameEngine::update(float dt) {
    if (dt <= 0.0f) return;
    if (dt > 0.25f) dt = 0.25f;   // a stalled loop must not teleport the world

    // A room in its lobby has nothing to simulate: the host has not pressed
    // Start yet.
    if (!matchStarted_) return;

    if (state_.round.matchOver) return;   // idle until someone asks to restart

    if (state_.round.roundOver) {
        state_.round.countdown -= dt;
        if (state_.round.countdown <= 0.0f) {
            if (state_.round.matchWinner >= 0) {
                state_.round.matchOver = true;
            } else {
                startRound();
            }
        }
        return;
    }

    state_.round.gameTime += dt;

    for (int i = 0; i < MAX_PLAYERS; ++i) {
        PlayerState& p = state_.players[i];
        if (p.dashTimer > 0.0f) p.dashTimer = std::max(0.0f, p.dashTimer - dt);
        if (p.dashCooldown > 0.0f) p.dashCooldown = std::max(0.0f, p.dashCooldown - dt);
        p.dashing = p.dashTimer > 0.0f;

        if (!p.occupied || !p.alive) {
            p.move = 0.0f;
            p.vel = 0.0f;
            syncDerived(p);
            continue;
        }

        if (p.isBot) botThink(p, dt);
        updatePlayer(p, dt);
    }

    for (int i = 0; i < MAX_BALLS; ++i) {
        if (state_.balls[i].active) updateBall(state_.balls[i], dt);
    }

    state_.round.ballTimer += dt;
    if (state_.round.ballTimer >= BALL_SPAWN_PERIOD) {
        state_.round.ballTimer = 0.0f;
        spawnExtraBall();
    }

    checkRoundEnd();
}

void GameEngine::updatePlayer(PlayerState& p, float dt) {
    const float before = p.pos;
    p.pos = clampf(p.pos + p.move * PADDLE_SPEED * dt, -POS_LIMIT, POS_LIMIT);
    p.vel = (p.pos - before) / dt;
    syncDerived(p);
}

void GameEngine::updateBall(BallState& ball, float dt) {
    // Substep so a fast ball cannot tunnel through a wall between two frames.
    const float travel = ballSpeed(ball) * dt;
    int steps = 1;
    if (travel > BALL_RADIUS) {
        steps = static_cast<int>(travel / BALL_RADIUS) + 1;
        if (steps > 16) steps = 16;
    }
    const float sub = dt / static_cast<float>(steps);

    for (int s = 0; s < steps; ++s) {
        ball.x += ball.vx * sub;
        ball.y += ball.vy * sub;

        if (ball.x < -BALL_LIMIT) {
            ball.x = -BALL_LIMIT;
            resolveWallHit(ball, Wall::Left);
        } else if (ball.x > BALL_LIMIT) {
            ball.x = BALL_LIMIT;
            resolveWallHit(ball, Wall::Right);
        }

        if (ball.y < -BALL_LIMIT) {
            ball.y = -BALL_LIMIT;
            resolveWallHit(ball, Wall::Bottom);
        } else if (ball.y > BALL_LIMIT) {
            ball.y = BALL_LIMIT;
            resolveWallHit(ball, Wall::Top);
        }
    }
}

// A ball reached a wall: either the wall's owner had their paddle in the way,
// or they conceded a point. Seats and walls share an index.
void GameEngine::resolveWallHit(BallState& ball, Wall wall) {
    PlayerState& owner = state_.players[static_cast<int>(wall)];
    const bool vertical = (wall == Wall::Left || wall == Wall::Right);

    const float impact = vertical ? ball.y : ball.x;
    const bool canDefend = owner.occupied && owner.alive;
    const float halfLen = PADDLE_HALF_LEN *
                          ((canDefend && owner.dashTimer > 0.0f) ? DASH_PADDLE_SCALE : 1.0f);

    const bool blocked = canDefend && std::fabs(impact - owner.pos) <= halfLen;

    float nx = 0.0f, ny = 0.0f;
    switch (wall) {
        case Wall::Left:   nx = 1.0f;  break;
        case Wall::Right:  nx = -1.0f; break;
        case Wall::Top:    ny = -1.0f; break;
        case Wall::Bottom: ny = 1.0f;  break;
    }

    float deflect;
    float speed;

    if (blocked) {
        // Aim by contact point: centre sends the ball straight back, the edges
        // send it away at an angle. A dash adds real punch.
        const float offset = clampf((impact - owner.pos) / halfLen, -1.0f, 1.0f);
        deflect = offset * MAX_DEFLECT;

        speed = ballSpeed(ball) * BALL_SPEED_BOUNCE;
        if (owner.dashTimer > 0.0f) speed *= DASH_SPEED_MULT;
        speed = clampf(speed, BALL_SPEED_BASE, BALL_SPEED_MAX);
    } else {
        if (canDefend) applyDamage(owner, 1);

        // Conceded: the ball comes back toward the middle at base speed so the
        // player who just lost a point gets a moment to reposition.
        deflect = (frand() * 2.0f - 1.0f) * MAX_DEFLECT * 0.5f;
        speed = BALL_SPEED_BASE;
    }

    const float cs = std::cos(deflect);
    const float sn = std::sin(deflect);
    ball.vx = (nx * cs - ny * sn) * speed;
    ball.vy = (nx * sn + ny * cs) * speed;
}

void GameEngine::applyDamage(PlayerState& p, int amount) {
    p.hp -= amount;
    if (p.hp <= 0) {
        p.hp = 0;
        p.alive = false;
        p.move = 0.0f;
        p.dashTimer = 0.0f;
        p.dashing = false;
    }
}

void GameEngine::checkRoundEnd() {
    int aliveCount = 0;
    int lastAlive = -1;

    for (int i = 0; i < MAX_PLAYERS; ++i) {
        const PlayerState& p = state_.players[i];
        if (!p.occupied || !p.alive) continue;
        ++aliveCount;
        lastAlive = i;
    }
    if (aliveCount > 1) return;

    state_.round.roundOver = true;
    state_.round.countdown = ROUND_END_DELAY;
    state_.round.winner = (aliveCount == 1) ? lastAlive : -1;

    if (state_.round.winner >= 0) {
        PlayerState& winner = state_.players[state_.round.winner];
        winner.roundsWon++;
        if (winner.roundsWon >= state_.round.roundsToWin) {
            state_.round.matchWinner = state_.round.winner;
        }
    }

    for (int i = 0; i < MAX_BALLS; ++i) {
        state_.balls[i].active = false;
    }
}

// ─── Bot AI ────────────────────────────────────────────────────────

void GameEngine::botThink(PlayerState& p, float dt) {
    const BotPreset& preset = kPresets[static_cast<int>(botDifficulty_)];
    const bool vertical = (p.wall == Wall::Left || p.wall == Wall::Right);

    p.botTimer -= dt;
    if (p.botTimer <= 0.0f) {
        p.botTimer = preset.reaction;

        int threatIndex = -1;
        float threatTime = 1.0e9f;
        float threatImpact = 0.0f;

        for (int i = 0; i < MAX_BALLS; ++i) {
            const BallState& ball = state_.balls[i];
            if (!ball.active) continue;

            // Distance to this bot's wall and the speed closing on it.
            float distance;
            float closing;
            switch (p.wall) {
                case Wall::Left:
                    distance = ball.x + BALL_LIMIT;
                    closing = -ball.vx;
                    break;
                case Wall::Right:
                    distance = BALL_LIMIT - ball.x;
                    closing = ball.vx;
                    break;
                case Wall::Top:
                    distance = BALL_LIMIT - ball.y;
                    closing = ball.vy;
                    break;
                case Wall::Bottom:
                default:
                    distance = ball.y + BALL_LIMIT;
                    closing = -ball.vy;
                    break;
            }

            if (closing <= 1.0f) continue;   // moving away, not a threat

            const float eta = distance / closing;
            if (eta >= threatTime) continue;

            // Where it lands along the wall, following its sideways rebounds.
            const float start = vertical ? ball.y : ball.x;
            const float perpVel = vertical ? ball.vy : ball.vx;

            threatTime = eta;
            threatIndex = i;
            threatImpact = foldAlong(start + perpVel * eta, BALL_LIMIT);
        }

        if (threatIndex < 0) {
            p.botTarget = 0.0f;   // nothing incoming: drift to the middle
        } else {
            const float jitter = (frand() * 2.0f - 1.0f) * preset.error;
            p.botTarget = clampf(threatImpact + jitter, -POS_LIMIT, POS_LIMIT);
        }

        // Dash when a shot is about to arrive on the paddle.
        if (threatIndex >= 0 && threatTime < 0.35f && p.dashCooldown <= 0.0f) {
            if (std::fabs(threatImpact - p.pos) <= PADDLE_HALF_LEN &&
                frand() < preset.aggression) {
                requestDash(p.seat);
            }
        }
    }

    // Steer toward the decided target, easing in so movement looks natural.
    p.move = clampf((p.botTarget - p.pos) / 12.0f, -1.0f, 1.0f);
}
