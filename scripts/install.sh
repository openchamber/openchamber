#!/usr/bin/env bash
# ALIAS ADE Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/btriapitsyn/alias-ade/main/scripts/install.sh | bash

set -e

PACKAGE_NAME="@alias-ade/web"
MIN_NODE_VERSION=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() {
  echo -e "${BLUE}info${NC}  $1"
}

success() {
  echo -e "${GREEN}success${NC}  $1"
}

warn() {
  echo -e "${YELLOW}warn${NC}  $1"
}

error() {
  echo -e "${RED}error${NC}  $1"
}

# Check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Get Node.js major version
get_node_version() {
  if command_exists node; then
    node -v | sed 's/v//' | cut -d. -f1
  else
    echo "0"
  fi
}

# Detect preferred package manager
detect_package_manager() {
  # Check if running inside an npm/pnpm/yarn/bun context
  if [ -n "$npm_config_user_agent" ]; then
    case "$npm_config_user_agent" in
      pnpm*) echo "pnpm"; return ;;
      yarn*) echo "yarn"; return ;;
      bun*) echo "bun"; return ;;
      npm*) echo "npm"; return ;;
    esac
  fi

  # Check for lockfiles in current directory (user preference)
  if [ -f "pnpm-lock.yaml" ]; then
    echo "pnpm"; return
  elif [ -f "yarn.lock" ]; then
    echo "yarn"; return
  elif [ -f "bun.lockb" ]; then
    echo "bun"; return
  elif [ -f "package-lock.json" ]; then
    echo "npm"; return
  fi

  # Check which package managers are available (prefer pnpm > bun > yarn > npm)
  if command_exists pnpm; then
    echo "pnpm"
  elif command_exists bun; then
    echo "bun"
  elif command_exists yarn; then
    echo "yarn"
  elif command_exists npm; then
    echo "npm"
  else
    echo "none"
  fi
}

# Get install command for package manager
get_install_command() {
  local pm=$1
  case "$pm" in
    pnpm) echo "pnpm add -g $PACKAGE_NAME" ;;
    yarn) echo "yarn global add $PACKAGE_NAME" ;;
    bun) echo "bun add -g $PACKAGE_NAME" ;;
    npm) echo "npm install -g $PACKAGE_NAME" ;;
    *) echo "" ;;
  esac
}

# Install Node.js suggestion
suggest_node_install() {
  echo ""
  error "Node.js $MIN_NODE_VERSION+ is required but not found."
  echo ""
  echo "Install Node.js using one of these methods:"
  echo ""
  
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  Using Homebrew:"
    echo "    brew install node"
    echo ""
  fi
  
  echo "  Using nvm (recommended):"
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "    nvm install $MIN_NODE_VERSION"
  echo ""
  echo "  Using fnm:"
  echo "    curl -fsSL https://fnm.vercel.app/install | bash"
  echo "    fnm install $MIN_NODE_VERSION"
  echo ""
  echo "  Official installer:"
  echo "    https://nodejs.org/"
  echo ""
  exit 1
}

# Install package manager suggestion
suggest_pm_install() {
  echo ""
  error "No package manager found (npm, pnpm, yarn, or bun)."
  echo ""
  echo "Install a package manager:"
  echo ""
  echo "  npm (comes with Node.js):"
  echo "    Install Node.js from https://nodejs.org/"
  echo ""
  echo "  pnpm (recommended):"
  echo "    curl -fsSL https://get.pnpm.io/install.sh | sh -"
  echo ""
  echo "  bun:"
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo ""
  echo "  yarn:"
  echo "    npm install -g yarn"
  echo ""
  exit 1
}

main() {
  echo ""
  echo "  ╭───────────────────────────────────╮"
  echo "  │                                   │"
  echo "  │   ALIAS ADE Installer           │"
  echo "  │   Web interface for OpenCode      │"
  echo "  │                                   │"
  echo "  ╰───────────────────────────────────╯"
  echo ""

  # Check Node.js
  info "Checking Node.js..."
  NODE_VERSION=$(get_node_version)
  
  if [ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]; then
    if [ "$NODE_VERSION" -eq "0" ]; then
      suggest_node_install
    else
      error "Node.js $MIN_NODE_VERSION+ required, found v$NODE_VERSION"
      suggest_node_install
    fi
  fi
  success "Node.js v$NODE_VERSION found"

  # Detect package manager
  info "Detecting package manager..."
  PM=$(detect_package_manager)
  
  if [ "$PM" = "none" ]; then
    suggest_pm_install
  fi
  success "Using $PM"

  # Get install command
  INSTALL_CMD=$(get_install_command "$PM")
  
  if [ -z "$INSTALL_CMD" ]; then
    error "Could not determine install command"
    exit 1
  fi

  # Install
  echo ""
  info "Installing ALIAS ADE..."
  echo "  Running: $INSTALL_CMD"
  echo ""
  
  if eval "$INSTALL_CMD"; then
    echo ""
    success "ALIAS ADE installed successfully!"
    echo ""
    echo "  Get started:"
    echo "    alias-ade              # Start server on port 3000"
    echo "    alias-ade --help       # Show all options"
    echo ""
    echo "  Prerequisites:"
    echo "    Make sure OpenCode is running: opencode serve"
    echo ""
  else
    echo ""
    error "Installation failed"
    echo ""
    echo "  Try running manually:"
    echo "    $INSTALL_CMD"
    echo ""
    echo "  If you get permission errors, see:"
    echo "    https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
    echo ""
    exit 1
  fi
}

main "$@"
