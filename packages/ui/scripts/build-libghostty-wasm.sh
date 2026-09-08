#!/usr/bin/env bash
#
# Rebuilds the vendored libghostty-vt WebAssembly artifact from the Ghostty
# revision pinned in src/lib/ghostty/vendor/VERSION, plus the PTY write
# trampoline whose bytes are embedded in src/lib/ghostty/runtime.ts.
#
# Usage:  bun run --cwd packages/ui build:ghostty-wasm
#
# The build is reproducible: the same revision and Zig version produce a
# byte-identical ghostty-vt.wasm. Bump VERSION, run this script, and commit the
# new artifact together with any ABI changes in core.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GHOSTTY_DIR="${UI_DIR}/src/lib/ghostty"
VENDOR_DIR="${GHOSTTY_DIR}/vendor"

GHOSTTY_REVISION="$(tr -d '[:space:]' < "${VENDOR_DIR}/VERSION")"
CACHE_DIR="${OPENCHAMBER_GHOSTTY_CACHE:-${HOME}/.cache/openchamber-ghostty}"
GHOSTTY_SOURCE_DIR="${GHOSTTY_SOURCE_DIR:-${CACHE_DIR}/ghostty-${GHOSTTY_REVISION:0:8}}"
GHOSTTY_ZIG_VERSION="${GHOSTTY_ZIG_VERSION:-0.15.2}"
GHOSTTY_ZIG="${GHOSTTY_ZIG:-}"

log() {
  printf '[libghostty-vt-wasm] %s\n' "$*"
}

die() {
  printf '[libghostty-vt-wasm] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

ensure_zig() {
  if [[ -n "${GHOSTTY_ZIG}" ]]; then
    [[ -x "${GHOSTTY_ZIG}" ]] || die "GHOSTTY_ZIG is not executable: ${GHOSTTY_ZIG}"
    return
  fi
  if command -v zig >/dev/null 2>&1 && [[ "$(zig version)" == "${GHOSTTY_ZIG_VERSION}" ]]; then
    GHOSTTY_ZIG="$(command -v zig)"
    return
  fi

  local host_os host_arch zig_dir
  host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  host_arch="$(uname -m)"
  case "${host_os}" in
    darwin) host_os="macos" ;;
    linux) ;;
    *) die "unsupported host OS for Zig download: ${host_os}" ;;
  esac
  case "${host_arch}" in
    arm64) host_arch="aarch64" ;;
    aarch64 | x86_64) ;;
    *) die "unsupported host architecture: ${host_arch}" ;;
  esac

  zig_dir="${CACHE_DIR}/zig-${GHOSTTY_ZIG_VERSION}"
  GHOSTTY_ZIG="${zig_dir}/zig"
  if [[ -x "${GHOSTTY_ZIG}" ]]; then
    return
  fi

  require_cmd curl
  require_cmd tar
  mkdir -p "${zig_dir}"
  log "downloading Zig ${GHOSTTY_ZIG_VERSION}"
  curl -fsSL \
    "https://ziglang.org/download/${GHOSTTY_ZIG_VERSION}/zig-${host_arch}-${host_os}-${GHOSTTY_ZIG_VERSION}.tar.xz" \
    | tar -xJ --strip-components=1 -C "${zig_dir}"
}

# Zig 0.15.2 links its build runner against the macOS SDK's libSystem stub.
# SDKs shipped with Xcode 26.x and later list only `arm64e-macos` in that
# stub, which Zig rejects for an arm64 host, so every native link fails with
# "undefined symbol: _abort". The wasm target itself is unaffected. Work around
# it with a minimal SDK root whose stubs also declare `arm64-macos`, and an
# xcrun shim so Zig's SDK lookup lands on it.
ensure_macos_sdk_shim() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0
  local sdk_path
  sdk_path="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
  [[ -n "${sdk_path}" ]] || die "xcrun could not locate a macOS SDK; install the Command Line Tools"
  if grep -q "arm64-macos" "${sdk_path}/usr/lib/libSystem.tbd" 2>/dev/null; then
    return 0
  fi

  local shim_root="${CACHE_DIR}/sdk-shim"
  local shim_sdk="${shim_root}/MacOSX.sdk"
  rm -rf "${shim_root}"
  mkdir -p "${shim_sdk}/usr/lib/system" "${shim_root}/bin"
  cp "${sdk_path}"/SDKSettings.* "${shim_sdk}/" 2>/dev/null || true
  ln -s "${sdk_path}/usr/include" "${shim_sdk}/usr/include"
  cp "${sdk_path}"/usr/lib/*.tbd "${shim_sdk}/usr/lib/"
  cp "${sdk_path}"/usr/lib/system/*.tbd "${shim_sdk}/usr/lib/system/"
  local stub
  for stub in "${shim_sdk}"/usr/lib/*.tbd "${shim_sdk}"/usr/lib/system/*.tbd; do
    sed -i '' 's/arm64e-macos/arm64-macos, arm64e-macos/g' "${stub}"
  done
  cat > "${shim_root}/bin/xcrun" <<EOF
#!/bin/sh
case "\$*" in
  *--show-sdk-path*) echo "${shim_sdk}" ;;
  *) exec /usr/bin/xcrun "\$@" ;;
esac
EOF
  chmod +x "${shim_root}/bin/xcrun"
  export PATH="${shim_root}/bin:${PATH}"
  log "using patched macOS SDK stubs from ${shim_sdk}"
}

ensure_ghostty_source() {
  require_cmd git
  if [[ ! -d "${GHOSTTY_SOURCE_DIR}/.git" ]]; then
    mkdir -p "$(dirname "${GHOSTTY_SOURCE_DIR}")"
    log "cloning Ghostty ${GHOSTTY_REVISION}"
    git clone --filter=blob:none --no-checkout https://github.com/ghostty-org/ghostty.git \
      "${GHOSTTY_SOURCE_DIR}"
  fi

  local actual_revision
  actual_revision="$(git -C "${GHOSTTY_SOURCE_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
  if [[ "${actual_revision}" != "${GHOSTTY_REVISION}" ]]; then
    log "checking out Ghostty ${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" fetch --depth=1 origin "${GHOSTTY_REVISION}"
    git -C "${GHOSTTY_SOURCE_DIR}" checkout --detach "${GHOSTTY_REVISION}"
  fi

  actual_revision="$(git -C "${GHOSTTY_SOURCE_DIR}" rev-parse HEAD)"
  [[ "${actual_revision}" == "${GHOSTTY_REVISION}" ]] || \
    die "expected Ghostty ${GHOSTTY_REVISION}, found ${actual_revision}"
}

ensure_zig
ensure_macos_sdk_shim
ensure_ghostty_source

build_root="$(mktemp -d)"
trap 'rm -rf "${build_root}"' EXIT

log "building ${GHOSTTY_REVISION} for wasm32-freestanding"
(
  cd "${GHOSTTY_SOURCE_DIR}"
  # The pinned revision rides along as semver build metadata so the artifact
  # identifies its own provenance through ghostty_build_info(); VERSION stays
  # the single source of truth for the pin and the ABI test checks the two agree.
  "${GHOSTTY_ZIG}" build \
    -Demit-lib-vt \
    -Dtarget=wasm32-freestanding \
    -Doptimize=ReleaseSmall \
    -Dstrip=true \
    -Dlib-version-string="0.1.0-dev+${GHOSTTY_REVISION}" \
    -p "${build_root}"
)

cp "${build_root}/bin/ghostty-vt.wasm" "${VENDOR_DIR}/ghostty-vt.wasm"
chmod 0644 "${VENDOR_DIR}/ghostty-vt.wasm"
log "wrote ${VENDOR_DIR}/ghostty-vt.wasm"

"${GHOSTTY_ZIG}" build-exe \
  "${SCRIPT_DIR}/ghostty-write-pty.zig" \
  -target wasm32-freestanding \
  -O ReleaseSmall \
  -fno-entry \
  -rdynamic \
  -femit-bin="${build_root}/ghostty-write-pty.wasm"
log "PTY trampoline bytes for runtime.ts (WRITE_PTY_TRAMPOLINE):"
od -An -v -tu1 "${build_root}/ghostty-write-pty.wasm" | tr -s ' \n' ' ' | sed 's/^ //; s/ $//; s/ /, /g'
echo
