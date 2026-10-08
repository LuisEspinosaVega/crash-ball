# CMakeLists.txt — Crash Ball Arena

cmake_minimum_required(VERSION 3.14)
project(CrashBall CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ─── Target ────────────────────────────────────────────────────────
# The server, the game simulation and the static file responder compile into
# a single binary. Server/ai.cpp, Server/network.h and Server/server.cpp.new
# are superseded dead code and are intentionally not part of the build; they
# are kept, unbuilt, under Server/ and Server/../legacy for reference.

add_executable(server
    Server/server.cpp
    Server/game_state.cpp
)

target_include_directories(server PRIVATE Server)

# ─── Warnings ──────────────────────────────────────────────────────

if(MSVC)
    target_compile_options(server PRIVATE /W4 /permissive- /utf-8)
    target_compile_definitions(server PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
    target_compile_options(server PRIVATE -Wall -Wextra -Wpedantic)
endif()

# ─── Platform libraries ────────────────────────────────────────────

if(WIN32)
    # Winsock. MSVC gets threading from the CRT, so pthread must not be linked
    # here — doing so unconditionally was one of the original build failures.
    # winmm provides timeBeginPeriod: without it Windows sleeps in 15.6 ms steps
    # and the 60 Hz game loop silently runs at half speed.
    target_link_libraries(server PRIVATE ws2_32 winmm)
else()
    find_package(Threads REQUIRED)
    target_link_libraries(server PRIVATE Threads::Threads)
endif()

# ─── Install ───────────────────────────────────────────────────────

install(TARGETS server RUNTIME DESTINATION bin)

message(STATUS "Crash Ball: ${CMAKE_SYSTEM_NAME}, C++17, compiler ${CMAKE_CXX_COMPILER_ID}")
