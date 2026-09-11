# syntax=docker/dockerfile:1
# OpenCode server instance image for OpenChamber-managed Docker instances.
#
# Built only when the user explicitly requests it from the instance creation
# flow (OpenChamber never pulls or builds unprompted):
#   docker build -f docker/opencode-instance/Dockerfile -t opencode-instance:local .
#
# The container runs non-root, binds nothing but the published port, and
# serves OpenCode on 0.0.0.0:4096 inside the container network namespace.
# OpenChamber mounts the user workspace at /workspace and publishes
# 127.0.0.1:<free port> -> 4096.

ARG NODE_VERSION=22-bookworm-slim
FROM node:${NODE_VERSION}

ARG OPENCODE_VERSION=latest
# Pin for reproducibility, e.g. --build-arg OPENCODE_VERSION=1.0.0
RUN npm install --global "opencode-ai@${OPENCODE_VERSION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash opencode
# Pre-create OpenCode's data/config directories with correct ownership BEFORE
# any bind mounts: Docker creates missing mount parents as root, which would
# leave the opencode user unable to mkdir inside its own data dir (EACCES at
# first serve — seen as a silent readiness timeout).
RUN mkdir -p /home/opencode/.local/share/opencode /home/opencode/.config/opencode \
  && chown -R opencode:opencode /home/opencode/.local /home/opencode/.config
USER opencode
WORKDIR /workspace

ENV OPENCODE_DISABLE_AUTOUPDATE=true
EXPOSE 4096

CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
