# syntax=docker/dockerfile:1
# Standalone backend image (API-only). Suitable for Render "Docker" deploys.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Native modules (better-sqlite3, node-pty) need build tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV OPENCHAMBER_HOST=0.0.0.0
ENV OPENCHAMBER_API_ONLY=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY bin ./bin

# Render provides PORT; the server honors it. Default local port is 3000.
EXPOSE 3000

CMD ["node", "server/index.js", "--host", "0.0.0.0"]
