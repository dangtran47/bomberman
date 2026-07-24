# Build context must be the repo root (workspace install needs the root
# lockfile and the shared package):
#   docker build -f packages/server/Dockerfile -t bomberman-server .
# fly deploy handles this automatically when run from the repo root with
# -c packages/server/fly.toml.
FROM node:22-slim

WORKDIR /app

# Install with just the manifests first so Docker caches the npm ci layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
# Dev deps are included on purpose: the server runs TypeScript via tsx.
RUN npm ci --workspace @bomberman/shared --workspace @bomberman/server

# The base tsconfig is required at runtime: each package's tsconfig extends it,
# and tsx/esbuild silently discards a tsconfig whose `extends` target is missing
# — which drops experimentalDecorators and makes Colyseus @type decorators crash.
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start", "--workspace", "@bomberman/server"]
