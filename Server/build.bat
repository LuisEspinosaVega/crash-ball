@echo off
setlocal
:: ===========================================================================
::  Crash Ball Arena - build & run (Windows)
::
::  Usage:  build.bat [port] [difficulty]
::            port        default 8080
::            difficulty  easy | medium | hard | expert   (default hard)
::
::  Uses CMake, which is what CMakeLists.txt is for. Falls back to a direct
::  cl.exe compile only if CMake is unavailable.
:: ===========================================================================

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"
set "DIFFICULTY=%~2"
if "%DIFFICULTY%"=="" set "DIFFICULTY=hard"

:: This script lives in Server/, so the project root (which holds
:: CMakeLists.txt and public/) is its parent directory.
cd /d "%~dp0.."

echo ==========================================
echo   CRASH BALL ARENA - COMPILACION
echo ==========================================
echo.

where cmake >nul 2>nul
if errorlevel 1 goto :nocmake

echo [1/2] Configurando con CMake...
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
if errorlevel 1 goto :failed

echo.
echo [2/2] Compilando...
cmake --build build --config Release
if errorlevel 1 goto :failed

set "SERVER=build\Release\server.exe"
if not exist "%SERVER%" set "SERVER=build\server.exe"

echo.
echo Compilacion correcta: %SERVER%
echo.
echo Abre  http://localhost:%PORT%/  en el navegador y juega.
echo Pulsa Ctrl+C para detener el servidor.
echo.
"%SERVER%" %PORT% %DIFFICULTY%
goto :eof

:nocmake
echo CMake no encontrado en PATH. Intentando compilar directamente con cl.exe...
echo (Se recomienda instalar CMake: https://cmake.org/download/ )
echo.

where cl >nul 2>nul
if errorlevel 1 goto :failed

if not exist build mkdir build
pushd build
cl /nologo /std:c++17 /EHsc /O2 /W4 /DNDEBUG /D_CRT_SECURE_NO_WARNINGS ^
   ..\Server\server.cpp ..\Server\game_state.cpp ^
   /I..\Server /Fe:server.exe /link ws2_32.lib
set "CL_RESULT=%errorlevel%"
popd
if not "%CL_RESULT%"=="0" goto :failed

echo.
echo Compilacion correcta: build\server.exe
echo Abre  http://localhost:%PORT%/  en el navegador y juega.
echo.
build\server.exe %PORT% %DIFFICULTY%
goto :eof

:failed
echo.
echo *** LA COMPILACION FALLO ***
echo.
echo Comprueba que tienes Visual Studio con las herramientas de C++ instaladas
echo y ejecuta este script desde un "Developer Command Prompt for VS".
exit /b 1
