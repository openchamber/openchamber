#!/usr/bin/env bash
#
# Release Build Test Script
#
# Runs the macOS Electron build from packages/electron for one architecture,
# with the same commands and environment as the build-desktop-electron-macos
# job in .github/workflows/release.yml. Run it on a Mac of the matching
# architecture before a release-related PR.
#
# Signing and notarization are not run here. The workflow's signature and
# notarization checks need the Apple secrets, so this script does not verify them.
#
# Usage:
#   ./scripts/test-release-build.sh [target] [options]
#
# Targets:
#   aarch64  - Apple Silicon (arm64), matches the workflow's macos-26 runner
#   x86_64   - Intel Mac (x64), matches the workflow's macos-15-intel runner
#   all      - Both architectures (default)
#
# Options:
#   --dry-run        Print the commands that would run; nothing is built
#   --verbose, -v    Enable electron-builder debug output (DEBUG=electron-builder)
#   --help, -h       Show this help message
#
# Examples:
#   ./scripts/test-release-build.sh x86_64         # Intel Mac build
#   ./scripts/test-release-build.sh --dry-run      # Print the plan only

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_DIR="packages/electron"
cd "$REPO_ROOT"

TARGET="all"
DRY_RUN=false
DEBUG_LOG=""

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

usage() {
    echo "Usage: $0 [target] [options]"
    echo ""
    echo "Targets:"
    echo "  aarch64, arm64, arm    Build for Apple Silicon (arm64)"
    echo "  x86_64, intel, x86     Build for Intel Mac (x64)"
    echo "  all, both              Build for both architectures (default)"
    echo ""
    echo "Options:"
    echo "  --dry-run          Print the commands without running them"
    echo "  --verbose, -v      Enable verbose output"
    echo "  --help, -h         Show this help message"
    exit 0
}

# One command per line as "<dir>|<command>". dir is "." (repo root) or
# ELECTRON_DIR. Mirrors the build-desktop-electron-macos job in release.yml.
release_commands() {
    local arch="$1"
    cat <<EOF
.|bun install --frozen-lockfile
$ELECTRON_DIR|bun run build:web-assets
$ELECTRON_DIR|bun run prepare:opencode-server
$ELECTRON_DIR|bun run verify:opencode-server
$ELECTRON_DIR|bun run prepare:ripgrep
$ELECTRON_DIR|bun run bundle:main
$ELECTRON_DIR|bun run rebuild:native
$ELECTRON_DIR|bunx electron-builder --mac --$arch --publish=never
$ELECTRON_DIR|bun run verify:opencode-server:packaged
EOF
}

check_macos_host() {
    local host_arch
    if [[ "$(uname -s)" != "Darwin" ]]; then
        log_error "Electron Builder packages macOS apps only on macOS (this host is $(uname -s))."
        log_info "Use --dry-run to print the commands on this host."
        exit 1
    fi
    host_arch="$(uname -m)"
    log_info "Host architecture: $host_arch"
    for command_name in bun node; do
        if ! command -v "$command_name" &> /dev/null; then
            log_error "$command_name is not installed"
            exit 1
        fi
    done
}

run_release_build() {
    local arch="$1"
    local dir cmd

    log_step "Building Electron app for $arch"

    while IFS='|' read -r dir cmd; do
        if [[ "$dir" == "." ]]; then
            log_info "$cmd"
            (cd "$REPO_ROOT" && bash -c "$cmd")
        else
            log_info "($dir) $cmd"
            (cd "$REPO_ROOT/$dir" && ELECTRON_BUILDER_ARCH="$arch" DEBUG="$DEBUG_LOG" bash -c "$cmd")
        fi
    done < <(release_commands "$arch")

    log_success "Electron build finished for $arch"
}

print_dry_run() {
    local arch="$1"
    local dir cmd

    log_step "Commands that would be executed for $arch (dry run, nothing was built)"
    while IFS='|' read -r dir cmd; do
        echo "[dry-run] $dir\$ $cmd"
    done < <(release_commands "$arch")
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        aarch64|arm64|arm)
            TARGET="aarch64"
            shift
            ;;
        x86_64|intel|x86)
            TARGET="x86_64"
            shift
            ;;
        all|both)
            TARGET="all"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --verbose|-v)
            DEBUG_LOG="electron-builder"
            shift
            ;;
        --help|-h)
            usage
            ;;
        *)
            log_error "Unknown argument: $1"
            usage
            ;;
    esac
done

# Electron Builder arch names, as the workflow's matrix.arch values.
declare -a ARCHES
case "$TARGET" in
    aarch64)
        ARCHES=("arm64")
        ;;
    x86_64)
        ARCHES=("x64")
        ;;
    all)
        ARCHES=("arm64" "x64")
        ;;
esac

log_step "Release Build Test Configuration"

log_info "Repository root: $REPO_ROOT"
log_info "Electron package: $ELECTRON_DIR"
log_info "Architecture(s): ${ARCHES[*]}"
log_info "Dry run: $DRY_RUN"

if [[ "$DRY_RUN" == true ]]; then
    for arch in "${ARCHES[@]}"; do
        print_dry_run "$arch"
    done
    echo ""
    log_success "Dry run complete. No build ran."
    exit 0
fi

check_macos_host

for arch in "${ARCHES[@]}"; do
    run_release_build "$arch"
done

echo ""
log_success "Release build test completed!"
log_info "Mirrors the build-desktop-electron-macos job in .github/workflows/release.yml"
log_info "Not run here: signature, hardened runtime, and notarization checks (need Apple secrets)"
