#!/usr/bin/env bash
#
# Test Release Build Script
# 
# This script tests the release workflow locally before creating a PR.
# It supports two modes:
#   1. `act` mode - Runs the GitHub workflow via act (limited macOS support)
#   2. `native` mode (default for macOS builds) - Runs build steps directly
#
# Prerequisites:
#   brew install act  (optional, for workflow testing)
#
# Usage:
#   ./scripts/test-release-build.sh [target] [options]
#
# Targets:
#   aarch64  - Build for Apple Silicon (arm64)
#   x86_64   - Build for Intel Mac (x86_64)
#   all      - Build for both architectures (default)
#
# Options:
#   --act            Force using act (Linux containers - limited macOS support)
#   --native         Force native build (default, recommended for macOS)
#   --dry-run        Show what would be run without executing
#   --verbose, -v    Enable verbose output
#   --no-bundle      Skip bundle creation (faster, just verify compilation)
#
# Examples:
#   ./scripts/test-release-build.sh x86_64         # Test Intel Mac build natively
#   ./scripts/test-release-build.sh --act          # Run workflow via act
#   ./scripts/test-release-build.sh --no-bundle    # Quick compilation check

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Change to repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Default values
TARGET="all"
MODE="native"  # native or act
DRY_RUN=false
VERBOSE=false
NO_BUNDLE=false

# Logging functions
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
    echo "  aarch64, arm64, arm    Build for Apple Silicon"
    echo "  x86_64, intel, x86     Build for Intel Mac"
    echo "  all, both              Build for both architectures (default)"
    echo ""
    echo "Options:"
    echo "  --act              Run via act (GitHub Actions in Docker - limited macOS)"
    echo "  --native           Run build commands directly (default, recommended)"
    echo "  --no-bundle        Skip bundle creation (faster compilation check)"
    echo "  --dry-run          Show what would be run without executing"
    echo "  --verbose, -v      Enable verbose output"
    echo "  --help, -h         Show this help message"
    exit 0
}

# Run workflow via act
run_with_act() {
    log_step "Running via act (GitHub Actions)"

    if ! command -v act &> /dev/null; then
        log_error "act is not installed. Install with: brew install act"
        log_info "Or use --native flag to run build commands directly (recommended)"
        exit 1
    fi
    log_success "act found: $(command -v act)"

    log_warn "⚠️  Note: act uses Docker (Linux containers)"
    log_warn "   macOS-specific steps (Tauri, Xcode, signing) may not work."
    log_warn "   For full macOS testing, use --native mode or GitHub's runners."
    echo ""

    # Build act command
    local ACT_CMD="act workflow_dispatch"
    ACT_CMD+=" -W .github/workflows/release.yml"
    ACT_CMD+=" --input version=0.0.0-test"
    ACT_CMD+=" --input dry_run=true"
    ACT_CMD+=" --container-architecture linux/amd64"
    ACT_CMD+=" --artifact-server-path $REPO_ROOT/.act-artifacts"

    # Filter to specific job for faster testing
    # publish-npm works in Linux containers; build-desktop-macos needs macOS
    ACT_CMD+=" --job publish-npm"

    if [[ "$VERBOSE" == true ]]; then
        ACT_CMD+=" --verbose"
    fi

    log_info "Command: $ACT_CMD"

    if [[ "$DRY_RUN" == true ]]; then
        log_warn "Dry run - not executing"
        return
    fi

    mkdir -p "$REPO_ROOT/.act-artifacts"
    eval "$ACT_CMD"
}

# Run build directly (native mode)
run_native_build() {
    log_step "Checking prerequisites"

    check_command() {
        if ! command -v "$1" &> /dev/null; then
            log_error "$1 is not installed"
            return 1
        fi
        log_success "$1 found: $(command -v "$1")"
    }

    check_command bun
    check_command rustc
    check_command cargo

    # Check Rust targets
    log_info "Checking Rust targets..."
    for target in "${TARGETS[@]}"; do
        if ! rustup target list --installed | grep -q "$target"; then
            log_warn "Rust target $target not installed. Installing..."
            if [[ "$DRY_RUN" == false ]]; then
                rustup target add "$target"
            fi
            log_success "Installed $target"
        else
            log_success "Rust target $target is installed"
        fi
    done

    if [[ "$DRY_RUN" == true ]]; then
        log_step "Commands that would be executed (dry run)"
        echo "  1. bun install --frozen-lockfile"
        echo "  2. bun run --cwd packages/ui build"
        for target in "${TARGETS[@]}"; do
            echo "  3. bun run --cwd packages/desktop build"
            if [[ "$NO_BUNDLE" == true ]]; then
                echo "  4. bun run --cwd packages/desktop tauri build --target $target --no-bundle"
            else
                echo "  4. bun run --cwd packages/desktop tauri build --target $target"
            fi
        done
        return
    fi

    # Step 1: Install dependencies
    log_step "Installing dependencies"
    bun install --frozen-lockfile

    # Step 2: Build UI package
    log_step "Building UI package"
    bun run --cwd packages/ui build

    # Step 3: Build Desktop for each target
    for target in "${TARGETS[@]}"; do
        log_step "Building Desktop for $target"

        # Build the frontend
        log_info "Building desktop frontend..."
        bun run --cwd packages/desktop build

        # Build Tauri for the target
        log_info "Building Tauri for $target (this may take a while)..."
        
        local TAURI_ARGS="--target $target"
        if [[ "$NO_BUNDLE" == true ]]; then
            TAURI_ARGS+=" --no-bundle"
        fi

        if [[ "$VERBOSE" == true ]]; then
            TAURI_ARGS+=" --verbose"
        fi

        bun run --cwd packages/desktop tauri build $TAURI_ARGS

        log_success "Successfully built for $target"
    done

    # Step 4: Show results
    log_step "Build Summary"

    for target in "${TARGETS[@]}"; do
        if [[ "$NO_BUNDLE" == true ]]; then
            local BINARY_PATH="packages/desktop/src-tauri/target/$target/release/openchamber-desktop"
        else
            local BINARY_PATH="packages/desktop/src-tauri/target/$target/release/bundle/dmg"
        fi

        if [[ -e "$BINARY_PATH" ]]; then
            if [[ -d "$BINARY_PATH" ]]; then
                log_success "$target: Bundle created at $BINARY_PATH"
                ls -la "$BINARY_PATH"/*.dmg 2>/dev/null || true
            else
                local SIZE
                SIZE=$(du -h "$BINARY_PATH" | cut -f1)
                log_success "$target: Binary built successfully ($SIZE)"
                file "$BINARY_PATH" 2>/dev/null || true
            fi
        else
            log_warn "$target: Output not found at expected path"
            log_info "Checking target directory..."
            ls -la "packages/desktop/src-tauri/target/$target/release/" 2>/dev/null | head -10 || true
        fi
    done
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
        --act)
            MODE="act"
            shift
            ;;
        --native)
            MODE="native"
            shift
            ;;
        --no-bundle)
            NO_BUNDLE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
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

# Determine which targets to build
declare -a TARGETS
case "$TARGET" in
    aarch64)
        TARGETS=("aarch64-apple-darwin")
        ;;
    x86_64)
        TARGETS=("x86_64-apple-darwin")
        ;;
    all)
        TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin")
        ;;
esac

log_step "Release Build Test Configuration"

log_info "Repository root: $REPO_ROOT"
log_info "Mode: $MODE"
log_info "Target(s): ${TARGETS[*]}"
log_info "No bundle: $NO_BUNDLE"
log_info "Dry run: $DRY_RUN"

# Run the selected mode
if [[ "$MODE" == "act" ]]; then
    run_with_act
else
    run_native_build
fi

echo ""
log_success "Release build test completed!"
echo ""
log_info "This script mirrors the build steps in .github/workflows/release.yml"
log_info "Note: Signing and notarization are skipped (require Apple secrets)"
echo ""
log_info "Next steps:"
echo "  1. If builds succeeded, your changes should work in CI"
echo "  2. For full workflow testing, push and use GitHub workflow_dispatch"
echo "  3. Create your PR with confidence"
