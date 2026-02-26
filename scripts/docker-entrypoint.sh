#!/usr/bin/env sh
set -eu

if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" | cut -d: -f6 2>/dev/null || true)"
fi

if [ -z "${HOME:-}" ]; then
  HOME="/home/bun"
fi

OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
export OPENCODE_CONFIG_DIR

OMO_INSTALL_ARGS="--no-tui --claude=no --openai=no --gemini=no --copilot=no --opencode-zen=no --zai-coding-plan=no --kimi-for-coding=no --skip-auth"

needs_init="false"
has_bootstrap_artifacts="false"

if [ ! -d "${OPENCODE_CONFIG_DIR}" ]; then
  needs_init="true"
else
  for bootstrap_path in opencode.json agents commands skills; do
    if [ -e "${OPENCODE_CONFIG_DIR}/${bootstrap_path}" ]; then
      has_bootstrap_artifacts="true"
      break
    fi
  done

  if [ "${has_bootstrap_artifacts}" != "true" ]; then
    needs_init="true"
  fi
fi

if [ "${needs_init}" = "true" ]; then
  echo "[entrypoint] opencode bootstrap artifacts missing, initializing: ${OPENCODE_CONFIG_DIR}"

  if ! command -v oh-my-opencode >/dev/null 2>&1; then
    echo "[entrypoint] error: oh-my-opencode not found; cannot initialize opencode config." >&2
    exit 1
  fi

  oh-my-opencode install ${OMO_INSTALL_ARGS}
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec bun packages/web/server/index.js --port "${OPENCHAMBER_PORT:-3000}"
