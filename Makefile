.PHONY: start install server client build test deploy deploy-fe deploy-server deploy-be

# Prod server URL baked into client bundle at build time
VITE_SERVER_URL ?= wss://bomberman-server-prd.fly.dev

# Install all workspace deps
install:
	npm install

# Start server + client together (Ctrl-C stops both)
start:
	@echo "Starting bomberman (server + client)..."
	@trap 'kill 0' INT TERM EXIT; \
	npm run dev --workspace=@bomberman/server & \
	npm run dev --workspace=@bomberman/client & \
	wait

# Server only (tsx watch)
server:
	npm run dev --workspace=@bomberman/server

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

# Build client with prod server URL + deploy to Cloudflare Pages
deploy deploy-fe:
	VITE_SERVER_URL=$(VITE_SERVER_URL) npm run build -w @bomberman/client
	npx wrangler pages deploy packages/client/dist --project-name bomberman

# Deploy server to Fly
deploy-server deploy-be:
	fly deploy -c packages/server/fly.toml
