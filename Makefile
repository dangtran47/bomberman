.PHONY: start install server client build test simtest deploy deploy-fe deploy-server deploy-be

# Prod server URL baked into client bundle at build time
VITE_SERVER_URL ?= wss://bomberman-server-prd.fly.dev

# Simulated round-trip latency (ms) for local dev; 0 = off.
# Usage: make start LAG=50
LAG ?= 0

# Install all workspace deps
install:
	npm install

# Start server + client together (Ctrl-C stops both)
start:
	@echo "Starting bomberman (server + client)..."
	@trap 'kill 0' INT TERM EXIT; \
	SIMULATE_LATENCY_MS=$(LAG) npm run dev --workspace=@bomberman/server & \
	npm run dev --workspace=@bomberman/client & \
	wait

# Server only (tsx watch)
server:
	SIMULATE_LATENCY_MS=$(LAG) npm run dev --workspace=@bomberman/server

# Client only (vite)
client:
	npm run dev --workspace=@bomberman/client

# Build both
build:
	npm run build --workspace=@bomberman/server
	npm run build --workspace=@bomberman/client

# Run all tests
test:
	npm test

# 4-browser multiplayer sim: spawns server (simulated latency) + client, then
# 4 Chrome windows play a full round via real UI/keyboard input.
# Usage: make simtest [LAG=50] [PLAYERS=4]
simtest: LAG = 50
simtest:
	LAG=$(LAG) PLAYERS=$(PLAYERS) node_modules/.bin/tsx scripts/multiplayer-sim.ts

# Deploy both frontend and backend
deploy: deploy-fe deploy-be

# Build client with prod server URL + deploy to Cloudflare Pages
deploy-fe:
	VITE_SERVER_URL=$(VITE_SERVER_URL) npm run build -w @bomberman/client
	npx wrangler pages deploy packages/client/dist --project-name bomberman

# Deploy server to Fly
deploy-server deploy-be:
	fly deploy -c packages/server/fly.toml
