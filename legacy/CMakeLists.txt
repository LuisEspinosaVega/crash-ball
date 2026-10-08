# CMakeLists.txt — Crash Ball Server

cmake_minimum_required(VERSION 3.10)
project(CrashBall CXX)

# ─── Compiler Options ──────────────────────────────────────────────

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
    set(CMAKE_CXX_FLAGS_RELEASE "/O2 /DNDEBUG")
    set(CMAKE_CXX_FLAGS_DEBUG "/Zi /Od")
else()
    set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")
    set(CMAKE_CXX_FLAGS_DEBUG "-g -O0")
endif()

# ─── Source Files ──────────────────────────────────────────────────

add_executable(server
    Server/server.cpp
    Server/game_state.cpp
    Server/ai.cpp
)

# ─── Libraries ─────────────────────────────────────────────────────

# Windows: Socket support
if(WIN32 OR CYGWIN)
    target_link_libraries(server ws2_32)
    # MinGW needs -lpthread for std::thread; MSVC gets threading from the CRT.
    # Linking pthread unconditionally broke the MSVC build at link time (LNK1104).
    if(NOT MSVC)
        target_link_libraries(server pthread)
    endif()
endif()

# Linux: Standard C++ library handles threads
if(UNIX)
    set(CMAKE_CMAKE_FLAGS "${CMAKE_CMAKE_FLAGS} -pthread")
    set_target_properties(server PROPERTIES
        LINKER_FLAGS -pthread
    )
endif()

# ─── Install Rules ─────────────────────────────────────────────────

install(TARGETS server DESTINATION bin)

# ─── Debug Symbols ─────────────────────────────────────────────────

if(BUILD_TYPE STREQUAL "Debug")
    set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -DDEBUG")
    set(CMAKE_CMAKE_FLAGS "${CMAKE_CMAKE_FLAGS} -g")
endif()

# ─── Print Build Info ──────────────────────────────────────────────

message(HEADLINE "Crash Ball Server Build Configuration")
message(DESCRIPTION "Platform: ${CMAKE_SYSTEM_NAME}")
message(DESCRIPTION "Compiler: ${CMAKE_CXX_COMPILER}")
message(DESCRIPTION "C++ Standard: C++17")
message(DESCRIPTION "Optimization: ${CMAKE_CXX_FLAGS}")
