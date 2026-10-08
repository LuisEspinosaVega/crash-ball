@echo off
:: Crash Ball Build Script for Windows
:: Prerequisites: g++ (MinGW/MSYS2) or Visual Studio C++

echo === Crash Ball Arena ===
echo Building server...

cd Server

:: Try g++ (MinGW)
g++ -std=c++17 -O2 \
    server.cpp \
    game_state.cpp \
    ai.cpp \
    -o server.exe \
    -lws2_32 2>nul

if %ERRORLEVEL% neq 0 (
    echo g++ build failed, trying with /EHsc...
    g++ -std=c++17 -O2 \
        server.cpp \
        game_state.cpp \
        ai.cpp \
        -o server.exe 2>nul
)

if %ERRORLEVEL% eq 0 (
    echo Build succeeded!
    echo Running server...
    .\server.exe 8080
else (
    echo Build failed. Install MinGW or use Visual Studio C++.
)
