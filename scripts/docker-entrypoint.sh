#!/usr/bin/env sh
set -eu

HOME="/home/openchamber"

OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
export OPENCODE_CONFIG_DIR

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"

mkdir -p "${SSH_DIR}"
if ! chmod 700 "${SSH_DIR}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_DIR}, continuing with existing permissions"
fi

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ] || [ ! -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  if [ ! -w "${SSH_DIR}" ]; then
    echo "[entrypoint] error: ssh key missing and ${SSH_DIR} is not writable" >&2
    exit 1
  fi

  echo "[entrypoint] generating SSH key..."
  ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null
fi

if ! chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PRIVATE_KEY_PATH}, continuing"
fi

if ! chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PUBLIC_KEY_PATH}, continuing"
fi

echo "[entrypoint] SSH public key:"
cat "${SSH_PUBLIC_KEY_PATH}"

# Handle UI_PASSWORD environment variable
OPENCHAMBER_ARGS=""

if [ -n "${UI_PASSWORD:-}" ]; then
  echo "[entrypoint] UI password set, enabling authentication"
  OPENCHAMBER_ARGS="${OPENCHAMBER_ARGS} --ui-password ${UI_PASSWORD}"
fi

# Handle Cloudflare Tunnel (CF_TUNNEL: true/qr/password/full)
if [ -n "${CF_TUNNEL:-}" ] && [ "${CF_TUNNEL:-false}" != "false" ]; then
  echo "[entrypoint] Cloudflare Tunnel enabled (${CF_TUNNEL})"
  OPENCHAMBER_ARGS="${OPENCHAMBER_ARGS} --try-cf-tunnel"

  case "${CF_TUNNEL}" in
  "qr")
    OPENCHAMBER_ARGS="${OPENCHAMBER_ARGS} --tunnel-qr"
    ;;
  esac

  case "${CF_TUNNEL}" in
  "password")
    OPENCHAMBER_ARGS="${OPENCHAMBER_ARGS} --tunnel-password-url"
    ;;
  esac
fi

if [ "${OH_MY_OPENCODE:-false}" = "true" ]; then
  OMO_CONFIG_FILE="${OPENCODE_CONFIG_DIR}/oh-my-opencode.json"

  if [ ! -f "${OMO_CONFIG_FILE}" ]; then
    echo "[entrypoint] npm installing oh-my-opencode..."
    npm install -g oh-my-opencode

    OMO_INSTALL_ARGS="--no-tui --claude=no --openai=no --gemini=no --copilot=no --opencode-zen=no --zai-coding-plan=no --kimi-for-coding=no --skip-auth"

    echo "[entrypoint] oh-my-opencode installing..."
    oh-my-opencode install ${OMO_INSTALL_ARGS}
  fi
fi

echo "[entrypoint] starting..."

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec bun packages/web/bin/cli.js ${OPENCHAMBER_ARGS}
