# syntax=docker/dockerfile:1
FROM archlinux:latest AS base
WORKDIR /app

# Install build dependencies in base stage
RUN pacman -Sy --noconfirm --needed bun  && \
  pacman -Scc --noconfirm

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/ui/package.json ./packages/ui/
COPY packages/web/package.json ./packages/web/
COPY packages/desktop/package.json ./packages/desktop/
COPY packages/vscode/package.json ./packages/vscode/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
RUN bun run build:web

FROM base AS runtime

RUN pacman -Sy --noconfirm --needed base-devel python openssh cloudflared git nodejs npm less && \
  pacman -Scc --noconfirm

ENV NODE_ENV=production

# Create openchamber user
RUN useradd -m -s /bin/bash openchamber

# Switch to openchamber user
USER openchamber

ENV NPM_CONFIG_PREFIX=/home/openchamber/.npm-global
ENV PATH=${NPM_CONFIG_PREFIX}/bin:${PATH}

RUN npm config set prefix /home/openchamber/.npm-global && mkdir -p /home/openchamber/.npm-global && \
  mkdir -p /home/openchamber/.local /home/openchamber/.config /home/openchamber/.ssh && \
  npm install -g opencode-ai

WORKDIR /home/openchamber
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json
COPY --from=builder /app/packages/web/bin ./packages/web/bin
COPY --from=builder /app/packages/web/server ./packages/web/server
COPY --from=builder /app/packages/web/dist ./packages/web/dist
COPY --chmod=755 scripts/docker-entrypoint.sh /app/openchamber-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/openchamber-entrypoint.sh"]
