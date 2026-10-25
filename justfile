# OpenChamber build recipes
#
#   just init       - install system deps + bun dependencies
#   just build      - build the Linux desktop app (AppImage, deb, rpm)
#   just web        - build web UI assets only
#   just artifacts  - list build artifacts
#   just clean      - remove build outputs

ELECTRON_DIST := 'packages/electron/dist'

default:
    @just --list

# System packages required by electron-builder + native module rebuild.
# Already present on most dev machines; safe to re-run.
deps_system:
    if ! command -v apt-get >/dev/null 2>&1; then echo 'just: init: assumes Debian/Ubuntu (apt-get). Adjust for your distro.'; exit 1; fi
    for pkg in build-essential python3 git ca-certificates libfuse3-3; do dpkg -s "$pkg" >/dev/null 2>&1 || { echo "just: missing system dep: $pkg (run: sudo apt-get install -y $pkg)"; exit 1; }; done
    echo 'just: system deps already installed.'

# Node/bun dependencies (workspace install, frozen lockfile).
# --ignore-scripts is safe: electron-builder downloads its own Electron.
deps_node:
    if ! command -v bun >/dev/null 2>&1; then echo 'just: bun not found. Install: curl -fsSL https://bun.sh/install | bash'; exit 1; fi
    echo 'just: installing bun dependencies (frozen lockfile)...'
    bun install --frozen-lockfile --ignore-scripts

# Full init: system + node deps.
init: deps_system deps_node

# Build the SDK (the server imports it at runtime).
build_sdk:
    echo 'just: building @openchamber/sdk...'
    bun run --cwd packages/sdk build

# Build web UI assets (Vite bundle).
build_web:
    echo 'just: building web UI assets...'
    bun run build:web

# Package the Electron desktop app (AppImage, deb, rpm).
build_electron:
    echo 'just: packaging Electron desktop app...'
    bun run --cwd packages/electron package

# Full build: SDK -> web -> electron package.
build: build_sdk build_web build_electron

# Build web assets only (no electron packaging).
web: build_sdk build_web

# List build artifacts.
artifacts:
    found=0; for f in {{ELECTRON_DIST}}/*.AppImage {{ELECTRON_DIST}}/*.deb {{ELECTRON_DIST}}/*.rpm; do if [ -f "$f" ]; then ls -lh "$f"; found=1; fi; done; if [ "$found" -eq 0 ]; then echo 'No artifacts found in {{ELECTRON_DIST}}/'; fi

# Clean build outputs.
clean:
    echo 'just: cleaning build outputs...'
    rm -rf packages/electron/dist packages/electron/dist-bundle packages/electron/resources/web-dist
    rm -rf packages/web/dist
    rm -rf packages/sdk/dist
    echo 'just: done.'
