# Crash Ball Arena — build and run helpers.
#
# The real build system is CMake (see CMakeLists.txt). This Makefile is a thin
# convenience wrapper so `make`, `make run` and `make test` work on Linux, macOS
# and Windows-with-GNU-make. It deliberately contains no compilation rules of
# its own: duplicating the source list here is how build files drift apart.

BUILD_DIR   ?= build
CONFIG      ?= Release
PORT        ?= 8080
DIFFICULTY  ?= hard
CMAKE       ?= cmake

ifeq ($(OS),Windows_NT)
    SERVER_BIN := $(BUILD_DIR)/$(CONFIG)/server.exe
    START_WEB  := start
else
    SERVER_BIN := $(BUILD_DIR)/server
    START_WEB  := xdg-open
endif

.PHONY: all configure build run test browser-test clean rebuild help

all: build

help:
	@echo "make build         Configure (if needed) and compile the server"
	@echo "make run           Build, then run the server on PORT=$(PORT) ($(DIFFICULTY))"
	@echo "make test          Build, then run the protocol smoke test"
	@echo "make browser-test  Build, then load the game in headless Chrome"
	@echo "make rebuild       Wipe the build directory and build from scratch"
	@echo "make clean         Remove the build directory"
	@echo ""
	@echo "Then open http://localhost:$(PORT)/ in a browser and play."

configure:
	@$(CMAKE) -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=$(CONFIG)

build: configure
	@$(CMAKE) --build $(BUILD_DIR) --config $(CONFIG)

run: build
	@echo "Abriendo http://localhost:$(PORT)/ — Ctrl+C para detener."
	@$(SERVER_BIN) $(PORT) $(DIFFICULTY)

test: build
	@$(SERVER_BIN) $(PORT) $(DIFFICULTY) & \
	 sleep 2; \
	 node tools/smoke-test.mjs $(PORT); \
	 status=$$?; \
	 kill %1 2>/dev/null; \
	 exit $$status

browser-test: build
	@$(SERVER_BIN) $(PORT) $(DIFFICULTY) & \
	 sleep 2; \
	 node tools/browser-test.mjs http://127.0.0.1:$(PORT)/; \
	 status=$$?; \
	 kill %1 2>/dev/null; \
	 exit $$status

rebuild: clean build

clean:
	@$(CMAKE) -E rm -rf $(BUILD_DIR)
