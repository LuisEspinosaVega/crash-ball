# 🎮 Crash Ball Arena

Multiplayer arcade game inspired by Crash Ball — 4-player arena with physics-based paddle combat.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Game Client (Web)                       │
│  HTML + Three.js + Vanilla JS                       │
│  ┌──────────────┐  ┌───────────────────┐            │
│  │ Three.js     │  │ WebSocket Client  │            │
│  │ Renderer     │  │ TCP Client (Raw)  │            │
│  └──────────────┘  └───────────────────┘            │
└─────────────────────────────────────────────────────┘
                     │ TCP/Ws
                     ▼
┌─────────────────────────────────────────────────────┐
│             Game Server (C++17)                     │
│  ┌──────────────┐  ┌───────────────────┐            │
│  │ Game Engine  │  │ Bot AI System     │            │
│  │ (Physics,     │  │ (Predictive      │            │
│  │  Collisions)  │  │  Tracking, 4     │            │
│  └──────────────┘  │  Levels)          │            │
│                    └───────────────────┘            │
│  ┌───────────────────┐                             │
│  │ Network Server    │                             │
│  │ (Raw Sockets)     │                             │
│  └───────────────────┘                             │
└─────────────────────────────────────────────────────┘
```

## Gameplay

- **4-player arena** — 2 vs 2 or free-for-all
- **Ball physics** — Speed increases with each bounce
- **Paddle combat** — Position determines shot direction
- **Attack/dash** — Power up ball shot (with cooldown)
- **Elimination** — Reach 0 health → barred port
- **Best of 3 rounds** — First to 3 round wins

## Controls (Client)

| Key | Action |
|-----|--------|
| ← → or A/D | Move paddle |
| Space / Enter | Dash/attack |
| R | Restart round |

## Setup & Build

### Server (C++)

**Option 1: CMake (Recommended)**

```bash
# Create build directory and configure
cmake -B build -DCMAKE_BUILD_TYPE=Release

# Build
cmake --build build

# Run the server (port 8080)
./build/server 8080
```

**Option 2: Direct g++ Build**

```bash
# Install dependencies
# Linux: sudo apt install g++
# macOS: brew install g++

# Build
g++ -std=c++17 -O2 \
    Server/server.cpp \
    Server/game_state.cpp \
    Server/ai.cpp \
    -o Server/server

# Run the server (port 8080)
./Server/server 8080
```

### Client (Web)

```bash
# Start web server
python3 -m http.server 3000 --directory public
```

Open `http://localhost:3000` in your browser.

## File Structure

```
space-ball/
├── Server/
│   ├── server.cpp          # TCP server + client handlers
│   ├── game_state.h        # Core game logic (physics, collisions)
│   ├── game_state.cpp      # Game engine implementation
│   ├── ai.h                # AI bot system (predictive tracking)
│   ├── ai.cpp              # Bot AI implementation
│   └── network.h           # Binary protocol for messages
├── public/
│   ├── index.html          # Game entry point
│   ├── game.js             # Three.js game client
│   └── styles.css          # UI styling
├── Makefile
├── CMakeLists.txt
└── README.md
```

## Game Mechanics

### Ball Physics
- Base speed: 200 pixels/sec
- Speed multiplier: 1.05× per bounce
- Max speed: 1500 pixels/sec
- Attack speed multiplier: 3.0×

### Bot Difficulty
| Level | Reaction | Aggression | Error |
|-------|----------|------------|-------|
| Easy | 250ms | 30% | ±30% |
| Medium | 100ms | 50% | ±15% |
| Hard | 30ms | 70% | ±5% |
| Expert | 5ms | 90% | ±1% |

## Protocol

- **TCP connection** (no WebSocket)
- **JSON-over-TCP** text protocol
- **Message types**: JOIN, JOIN_OK, ERROR, PLAYER_STATE, BALL_STATE, GAME_STATE
- **Rate**: 60 FPS (16ms tick rate)

## Requirements

### Server (C++)
- C++17 compiler (g++, clang++, or MSVC)
- CMake 3.14+ (optional)
- On Windows: Winsock library (included by default with MSVC)

### Client (Browser)
- Modern browser with WebGL 1.0+ support
- Three.js v0.128+
