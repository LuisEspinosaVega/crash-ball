# Crash Ball Arena — Build System

# Dependencies (Windows)
# - Boost.Asio (optional, or use raw sockets on Linux/Mac)
#
# Linux:
# sudo apt install g++ libboost-all-dev
#
# macOS:
# brew install g++ boost
#
# Windows:
# - Install Boost via Chocolatey or MSYS2

# ─── CMake Build (Recommended) ──────────────────────────────────────

# Create build directory and configure
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build

# Run the server
./build/server 8080

# ─── Direct g++ Build (Alternative) ────────────────────────────────

# Windows (MinGW)
g++ -std=c++17 -O2 \
    Server/server.cpp \
    Server/game_state.cpp \
    Server/ai.cpp \
    -o Server/server.exe \
    -lws2_32  # Windows sockets

# Linux
g++ -std=c++17 -O2 \
    Server/server.cpp \
    Server/game_state.cpp \
    Server/ai.cpp \
    -o Server/server

# macOS
g++ -std=c++17 -O2 \
    Server/server.cpp \
    Server/game_state.cpp \
    Server/ai.cpp \
    -o Server/server

# ─── Run ────────────────────────────────────────────────────────────

# Server (port 8080 by default)
./Server/server 8080

# Start web server (for local dev)
python3 -m http.server 3000 --directory public
