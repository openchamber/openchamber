#!/usr/bin/env bash
# OpenChamber Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/btriapitsyn/openchamber/main/scripts/install.sh | bash
#
# System-wide install on a Linux host (as root): OpenChamber runs as <account>,
# with the protected MCP service and a root updater:
#   curl -fsSL .../install.sh | sudo bash -s -- --host --owner <account> [--port 3000] [--repo owner/name]
#
# Protected MCP service alone (Linux, as root):
#   curl -fsSL .../install.sh | sudo bash -s -- --protected-mcp --engine-user <account>
#   curl -fsSL .../install.sh | sudo bash -s -- --protected-mcp-uninstall [--purge-state --engine-user <account>]

set -euo pipefail

PACKAGE_NAME="@openchamber/web"
BIN_NAME="openchamber"
MIN_NODE_MAJOR=24
MIN_NODE_MINOR=14
MIN_NODE_VERSION="$MIN_NODE_MAJOR.$MIN_NODE_MINOR"

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

# Get Node.js version as "major.minor", or "0.0" when Node.js is missing
get_node_version() {
  if command_exists node; then
    local version
    version=$(node -v 2>/dev/null || true)
    version=${version#v}
    if [[ "$version" =~ ^([0-9]+)\.([0-9]+) ]]; then
      echo "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
    else
      echo "0.0"
    fi
  else
    echo "0.0"
  fi
}

# Whether a "major.minor" version meets the minimum
node_version_supported() {
  local major=${1%%.*}
  local minor=${1#*.}
  [ "$major" -gt "$MIN_NODE_MAJOR" ] || { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }
}

# Detect preferred package manager
detect_package_manager() {
  # Check if running inside an npm/pnpm/yarn/bun context
  if [ -n "${npm_config_user_agent:-}" ]; then
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
  elif [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
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

# Flags that approve the dependency builds pnpm 10+ blocks; pnpm 11+ stops to
# ask about them in a terminal. `--allow-build` exists since pnpm 10.4.0; older
# versions reject it, and pnpm 9 and older run the builds without approval.
# Keep the list in sync with packages/web/server/lib/package-manager.js.
get_pnpm_allow_build_flags() {
  local version major minor
  version=$(pnpm --version 2>/dev/null || true)
  if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\. ]]; then
    major=${BASH_REMATCH[1]}
    minor=${BASH_REMATCH[2]}
    if [ "$major" -gt 10 ] || { [ "$major" -eq 10 ] && [ "$minor" -ge 4 ]; }; then
      echo " --allow-build=msgpackr-extract --allow-build=node-pty"
    fi
  fi
}

# Get install command for package manager
get_install_command() {
  local pm=$1
  case "$pm" in
    pnpm) echo "pnpm add -g$(get_pnpm_allow_build_flags) $PACKAGE_NAME" ;;
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
  
  if [[ "${OSTYPE:-}" == "darwin"* ]]; then
    echo "  Using Homebrew:"
    echo "    brew install node"
    echo ""
  fi
  
  echo "  Using nvm (recommended):"
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "    nvm install $MIN_NODE_MAJOR"
  echo ""
  echo "  Using fnm:"
  echo "    curl -fsSL https://fnm.vercel.app/install | bash"
  echo "    fnm install $MIN_NODE_MAJOR"
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

# The protected MCP service runs as its own account from root-owned files, so
# its code comes from the registry tarball, checked against the integrity npm
# publishes, and never from the engine-writable global install.

# One file or directory: owned by one of the owners, with no group or other
# write bit. That also covers ACLs: a named entry writes only through the ACL
# mask, and the group bits show the mask. A symbolic link is judged by its
# owner; its target is checked as a hop of its own.
protected_mcp_trusted_entry() {
  local entry="$1" owners="$2" owner mode
  owner=$(stat -c %u -- "$entry" 2>/dev/null) || return 1
  case " $owners " in *" $owner "*) ;; *) return 1 ;; esac
  [ -L "$entry" ] && return 0
  mode=$(stat -c %a -- "$entry" 2>/dev/null) || return 1
  (( (8#$mode & 8#022) == 0 ))
}

# True when only the owners (root, unless others are named) can change what
# the path runs. The path is walked the way the kernel resolves it: from /, one
# component at a time, following a link wherever it appears, in a directory
# component as much as in the last one. Every directory and link on that way
# must pass. Root executes the result, so anything that cannot be checked fails.
protected_mcp_trusted_path() {
  local target="$1"
  shift
  local owners="${*:-0}" current=/ next name link hops=0
  local -a pending=() parts=()
  case "$target" in /*) ;; *) return 1 ;; esac
  [ -e "$target" ] || return 1
  protected_mcp_trusted_entry / "$owners" || return 1
  IFS=/ read -r -a pending <<< "$target"
  while [ "${#pending[@]}" -gt 0 ]; do
    name="${pending[0]}"
    pending=("${pending[@]:1}")
    case "$name" in
      '' | .) continue ;;
      ..) current=$(dirname -- "$current"); continue ;;
    esac
    next="${current%/}/$name"
    protected_mcp_trusted_entry "$next" "$owners" || return 1
    if [ -L "$next" ]; then
      hops=$((hops + 1))
      [ "$hops" -le 40 ] || return 1
      link=$(readlink -- "$next") || return 1
      case "$link" in /*) current=/ ;; esac
      IFS=/ read -r -a parts <<< "$link"
      # The `+` form keeps bash before 4.4 from calling an empty array unbound.
      pending=("${parts[@]}" ${pending[@]+"${pending[@]}"})
    else
      current="$next"
    fi
  done
}

# Removes a directory when the script exits, however it exits. The trap holds
# the path itself: the caller's local variable is gone by then, and `set -u`
# would stop the trap on it.
protected_mcp_remove_on_exit() {
  trap "rm -rf -- $(printf '%q' "$1")" EXIT
}

protected_mcp_node() {
  local candidate
  for candidate in /usr/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ] && protected_mcp_trusted_path "$candidate" 0; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

protected_mcp_install() {
  if [ "$(uname -s)" != "Linux" ]; then
    error "The protected MCP service is for Linux hosts."
    exit 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    error "Run this with sudo: the protected MCP service needs its own system account."
    exit 1
  fi
  local node version metadata tarball integrity workdir package_version
  node=$(protected_mcp_node)
  if [ -z "$node" ]; then
    error "Install Node.js $MIN_NODE_VERSION+ system-wide at /usr/bin/node or /usr/local/bin/node, owned by root and writable only by root along its whole path, without ACLs (your distribution or NodeSource does this), then run this again."
    exit 1
  fi
  if ! protected_mcp_trusted_path /var/cache 0; then
    error "/var/cache must be owned and writable only by root: the package is unpacked there."
    exit 1
  fi
  version="${OPENCHAMBER_VERSION:-latest}"
  info "Reading $PACKAGE_NAME@$version from the npm registry..."
  metadata=$(curl -fsSL "https://registry.npmjs.org/@openchamber%2fweb/$version")
  tarball=$(printf '%s' "$metadata" | "$node" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).dist.tarball))')
  integrity=$(printf '%s' "$metadata" | "$node" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).dist.integrity))')
  workdir=$(mktemp -d /var/cache/openchamber-protected-mcp.XXXXXX)
  protected_mcp_remove_on_exit "$workdir"
  curl -fsSL "$tarball" -o "$workdir/package.tgz"
  if ! "$node" -e 'const c=require("crypto"),f=require("fs");const [a,h]=process.argv[2].split("-");process.exit(c.createHash(a).update(f.readFileSync(process.argv[1])).digest("base64")===h?0:1)' "$workdir/package.tgz" "$integrity"; then
    error "The downloaded package does not match the integrity the registry publishes."
    exit 1
  fi
  tar -xzf "$workdir/package.tgz" -C "$workdir" --no-same-owner --no-same-permissions
  chown -R root:root "$workdir"
  chmod -R go-w "$workdir"
  package_version=$("$node" -e 'process.stdout.write(require(process.argv[1]).version)' "$workdir/package/package.json")
  success "Verified $PACKAGE_NAME $package_version"
  "$node" "$workdir/package/server/lib/protected-mcp/service/install.js" install \
    --source "$workdir/package/server" --version "$package_version" --node "$node" "$@"
}

protected_mcp_uninstall() {
  if [ "$(id -u)" -ne 0 ]; then
    error "Run this with sudo."
    exit 1
  fi
  local installer=/usr/lib/openchamber-protected-mcp/current/lib/protected-mcp/service/install.js node
  if [ ! -f "$installer" ]; then
    error "The protected MCP service is not installed."
    exit 1
  fi
  node=$(protected_mcp_node)
  if [ -z "$node" ] || ! protected_mcp_trusted_path "$installer" 0; then
    error "Node.js or the installed service is not owned and writable only by root, so it is not run as root."
    exit 1
  fi
  "$node" "$installer" uninstall "$@"
}

# The GitHub repository whose releases a host install uses, unless --repo names another.
HOST_DEFAULT_REPO="rubimpassos/openchamber"

# Installs OpenChamber system-wide. The package comes from the repository's
# GitHub release and is checked against the SHA-256 digest GitHub records for
# it; its own host installer (server/lib/host-install) does the rest as root.
host_install() {
  if [ "$(uname -s)" != "Linux" ]; then
    error "The host install is for Linux hosts with systemd."
    exit 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    error "Run this with sudo: the host install creates system accounts and units."
    exit 1
  fi
  local node repo="" release workdir version url digest arg previous=""
  for arg in "$@"; do
    [ "$previous" = "--repo" ] && repo="$arg"
    previous="$arg"
  done
  node=$(protected_mcp_node)
  if [ -z "$node" ]; then
    error "Install Node.js $MIN_NODE_VERSION+ system-wide at /usr/bin/node or /usr/local/bin/node, owned by root and writable only by root along its whole path, without ACLs (your distribution or NodeSource does this), then run this again."
    exit 1
  fi
  if ! protected_mcp_trusted_path /var/cache 0; then
    error "/var/cache must be owned and writable only by root: the package is unpacked there."
    exit 1
  fi
  # A reinstall keeps the repository the host was installed from unless --repo names another.
  if [ -z "$repo" ] && [ -f /etc/openchamber/host.json ]; then
    repo=$("$node" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("/etc/openchamber/host.json", "utf8")).repo || ""))') || repo=""
  fi
  repo="${repo:-$HOST_DEFAULT_REPO}"
  info "Reading the latest release of $repo..."
  release=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/releases/latest")
  read -r version url digest < <(printf '%s' "$release" | "$node" -e '
    let s = ""; process.stdin.on("data", (c) => s += c).on("end", () => {
      const r = JSON.parse(s); const v = String(r.tag_name || "").replace(/^v/, "");
      const a = (r.assets || []).find((x) => x.name === `openchamber-web-${v}.tgz`);
      if (!a || !/^sha256:[0-9a-f]{64}$/.test(a.digest || "")) process.exit(1);
      process.stdout.write(`${v} ${a.browser_download_url} ${a.digest.slice(7)}\n`);
    });') || { error "The latest release of $repo has no web package with a recorded digest."; exit 1; }
  workdir=$(mktemp -d /var/cache/openchamber-host-install.XXXXXX)
  protected_mcp_remove_on_exit "$workdir"
  curl -fsSL "$url" -o "$workdir/package.tgz"
  if [ "$(sha256sum "$workdir/package.tgz" | cut -d' ' -f1)" != "$digest" ]; then
    error "The downloaded package does not match the digest GitHub records."
    exit 1
  fi
  tar -xzf "$workdir/package.tgz" -C "$workdir" --no-same-owner --no-same-permissions
  chown -R root:root "$workdir"
  chmod -R go-w "$workdir"
  if [ ! -f "$workdir/package/server/lib/host-install/main.js" ]; then
    error "OpenChamber $version has no host installer; it needs a newer release."
    exit 1
  fi
  success "Verified OpenChamber $version"
  "$node" "$workdir/package/server/lib/host-install/main.js" install \
    --repo "$repo" "$@" --tarball "$workdir/package.tgz" --version "$version"
}

main() {
  case "${1:-}" in
    --host)
      shift
      host_install "$@"
      return
      ;;
    --protected-mcp)
      shift
      protected_mcp_install "$@"
      return
      ;;
    --protected-mcp-uninstall)
      shift
      protected_mcp_uninstall "$@"
      return
      ;;
  esac

  echo ""
  echo "  ╭───────────────────────────────────╮"
  echo "  │                                   │"
  echo "  │   OpenChamber Installer           │"
  echo "  │   Web interface for OpenCode      │"
  echo "  │                                   │"
  echo "  ╰───────────────────────────────────╯"
  echo ""

  # Check Node.js
  info "Checking Node.js..."
  NODE_VERSION=$(get_node_version)

  if ! node_version_supported "$NODE_VERSION"; then
    if [ "$NODE_VERSION" = "0.0" ]; then
      suggest_node_install
    else
      error "Node.js $MIN_NODE_VERSION+ required, found v$NODE_VERSION"
      suggest_node_install
    fi
  fi
  success "Node.js v$NODE_VERSION found"

  # If OpenChamber is already installed, hand off to its own updater instead
  # of guessing a package manager. `openchamber update` detects which manager
  # actually owns the existing global install and reinstalls with that one —
  # reinstalling with a different manager here would orphan files and break PATH.
  if command_exists "$BIN_NAME"; then
    info "OpenChamber is already installed — updating via 'openchamber update'..."
    echo ""
    if openchamber update; then
      echo ""
      success "OpenChamber is up to date!"
      exit 0
    fi
    echo ""
    error "Update failed."
    echo ""
    echo "  Try running it manually:"
    echo "    openchamber update"
    echo ""
    exit 1
  fi

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
  info "Installing OpenChamber..."
  echo "  Running: $INSTALL_CMD"
  echo ""
  
  if eval "$INSTALL_CMD"; then
    echo ""
    # Wordmark (toilet "pagga", "Open"/"Chamber" stacked).
    # Hardcoded so the user needs no extra tools.
    printf '%b' "$BLUE"
    cat <<'EOF'
  ░█▀█░█▀█░█▀▀░█▀█
  ░█░█░█▀▀░█▀▀░█░█
  ░▀▀▀░▀░░░▀▀▀░▀░▀
  ░█▀▀░█░█░█▀█░█▄█░█▀▄░█▀▀░█▀▄
  ░█░░░█▀█░█▀█░█░█░█▀▄░█▀▀░█▀▄
  ░▀▀▀░▀░▀░▀░▀░▀░▀░▀▀░░▀▀▀░▀░▀
EOF
    printf '%b\n' "$NC"
    success "OpenChamber installed successfully!"
    echo ""

    # Verify the binary is actually reachable. Global installs frequently
    # land in a directory that isn't on PATH — surface that instead of
    # letting the user hit a confusing "command not found".
    if command_exists "$BIN_NAME"; then
      echo "  Get started:"
      echo "    openchamber              # Start server on port 3000"
      echo "    openchamber --help       # Show all options"
    else
      warn "'$BIN_NAME' was installed but isn't on your PATH yet."
      echo ""
      bin_dir=""
      case "$PM" in
        npm)  bin_dir=$(npm prefix -g 2>/dev/null)/bin ;;
        pnpm) bin_dir=$(pnpm bin -g 2>/dev/null || true) ;;
        yarn) bin_dir=$(yarn global bin 2>/dev/null || true) ;;
        bun)  bin_dir="${BUN_INSTALL:-$HOME/.bun}/bin" ;;
      esac
      if [ -n "$bin_dir" ]; then
        echo "  Add it to your PATH (then restart your terminal):"
        echo "    export PATH=\"$bin_dir:\$PATH\""
      else
        echo "  Add your package manager's global bin directory to PATH,"
        echo "  then restart your terminal and run: openchamber"
      fi
    fi
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

# Tests load the functions alone with OPENCHAMBER_INSTALL_FUNCTIONS_ONLY=1;
# `curl ... | bash` and `sudo bash` never carry it.
if [ -z "${OPENCHAMBER_INSTALL_FUNCTIONS_ONLY:-}" ]; then
  main "$@"
fi
