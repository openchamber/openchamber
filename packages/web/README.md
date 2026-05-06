# <picture><source media="(prefers-color-scheme: dark)" srcset="https://github.com/btriapitsyn/openchamber/raw/HEAD/docs/references/badges/openchamber-logo-dark.svg"><img src="https://github.com/btriapitsyn/openchamber/raw/HEAD/docs/references/badges/openchamber-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> @openchamber/web

[![GitHub stars](https://img.shields.io/github/stars/btriapitsyn/openchamber?style=flat&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgZmlsbD0iI2YxZWNlYyIgdmlld0JveD0iMCAwIDI1NiAyNTYiPjxwYXRoIGQ9Ik0yMjkuMDYsMTA4Ljc5bC00OC43LDQyLDE0Ljg4LDYyLjc5YTguNCw4LjQsMCwwLDEtMTIuNTIsOS4xN0wxMjgsMTg5LjA5LDczLjI4LDIyMi43NGE4LjQsOC40LDAsMCwxLTEyLjUyLTkuMTdsMTQuODgtNjIuNzktNDguNy00MkE4LjQ2LDguNDYsMCwwLDEsMzEuNzMsOTRMOTUuNjQsODguOGwyNC42Mi01OS42YTguMzYsOC4zNiwwLDAsMSwxNS40OCwwbDI0LjYyLDU5LjZMMjI0LjI3LDk0QTguNDYsOC40NiwwLDAsMSwyMjkuMDYsMTA4Ljc5WiIgb3BhY2l0eT0iMC4yIj48L3BhdGg%2BPHBhdGggZD0iTTIzOS4xOCw5Ny4yNkExNi4zOCwxNi4zOCwwLDAsMCwyMjQuOTIsODZsLTU5LTQuNzZMMTQzLjE0LDI2LjE1YTE2LjM2LDE2LjM2LDAsMCwwLTMwLjI3LDBMOTAuMTEsODEuMjMsMzEuMDgsODZhMTYuNDYsMTYuNDYsMCwwLDAtOS4zNywyOC44Nmw0NSwzOC44M0w1MywyMTEuNzVhMTYuMzgsMTYuMzgsMCwwLDAsMjQuNSwxNy44MkwxMjgsMTk4LjQ5bDUwLjUzLDMxLjA4QTE2LjQsMTYuNCwwLDAsMCwyMDMsMjExLjc1bC0xMy43Ni01OC4wNyw0NS0zOC44M0ExNi40MywxNi40MywwLDAsMCwyMzkuMTgsOTcuMjZabS0xNS4zNCw1LjQ3LTQ4LjcsNDJhOCw4LDAsMCwwLTIuNTYsNy45MWwxNC44OCw2Mi44YS4zNy4zNywwLDAsMS0uMTcuNDhjLS4xOC4xNC0uMjMuMTEtLjM4LDBsLTU0LjcyLTMzLjY1YTgsOCwwLDAsMC04LjM4LDBMNjkuMDksMjE1Ljk0Yy0uMTUuMDktLjE5LjEyLS4zOCwwYS4zNy4zNywwLDAsMS0uMTctLjQ4bDE0Ljg4LTYyLjhhOCw4LDAsMCwwLTIuNTYtNy45MWwtNDguNy00MmMtLjEyLS4xLS4yMy0uMTktLjEzLS41cy4xOC0uMjcuMzMtLjI5bDYzLjkyLTUuMTZBOCw4LDAsMCwwLDEwMyw5MS44NmwyNC42Mi01OS42MWMuMDgtLjE3LjExLS4yNS4zNS0uMjVzLjI3LjA4LjM1LjI1TDE1Myw5MS44NmE4LDgsMCwwLDAsNi43NSw0LjkybDYzLjkyLDUuMTZjLjE1LDAsLjI0LDAsLjMzLjI5UzIyNCwxMDIuNjMsMjIzLjg0LDEwMi43M1oiPjwvcGF0aD48L3N2Zz4%3D&logoColor=FFFCF0&labelColor=100F0F&color=66800B)](https://github.com/btriapitsyn/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/btriapitsyn/openchamber?style=flat&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgZmlsbD0iI2YxZWNlYyIgdmlld0JveD0iMCAwIDI1NiAyNTYiPjxwYXRoIGQ9Ik0xMjgsMTI5LjA5VjIzMmE4LDgsMCwwLDEtMy44NC0xbC04OC00OC4xOGE4LDgsMCwwLDEtNC4xNi03VjgwLjE4YTgsOCwwLDAsMSwuNy0zLjI1WiIgb3BhY2l0eT0iMC4yIj48L3BhdGg%2BPHBhdGggZD0iTTIyMy42OCw2Ni4xNSwxMzUuNjgsMThhMTUuODgsMTUuODgsMCwwLDAtMTUuMzYsMGwtODgsNDguMTdhMTYsMTYsMCwwLDAtOC4zMiwxNHY5NS42NGExNiwxNiwwLDAsMCw4LjMyLDE0bDg4LDQ4LjE3YTE1Ljg4LDE1Ljg4LDAsMCwwLDE1LjM2LDBsODgtNDguMTdhMTYsMTYsMCwwLDAsOC4zMi0xNFY4MC4xOEExNiwxNiwwLDAsMCwyMjMuNjgsNjYuMTVaTTEyOCwzMmw4MC4zNCw0NC0yOS43NywxNi4zLTgwLjM1LTQ0Wk0xMjgsMTIwLDQ3LjY2LDc2bDMzLjktMTguNTYsODAuMzQsNDRaTTQwLDkwbDgwLDQzLjc4djg1Ljc5TDQwLDE3NS44MlptMTc2LDg1Ljc4aDBsLTgwLDQzLjc5VjEzMy44MmwzMi0xNy41MVYxNTJhOCw4LDAsMCwwLDE2LDBWMTA3LjU1TDIxNiw5MHY4NS43N1oiPjwvcGF0aD48L3N2Zz4%3D&logoColor=FFFCF0&labelColor=100F0F&color=205EA6)](https://github.com/btriapitsyn/openchamber/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)

Run [OpenCode](https://opencode.ai) in your browser. Install the CLI, open `localhost:3000`, done. Works on desktop browsers, tablets, and phones as a PWA.

Full project overview, screenshots, and all features: [github.com/btriapitsyn/openchamber](https://github.com/btriapitsyn/openchamber)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/btriapitsyn/openchamber/main/scripts/install.sh | bash
```

Or install manually: `bun add -g @openchamber/web` (or npm, pnpm, yarn).

> **Prerequisites:** [OpenCode CLI](https://opencode.ai) installed, Node.js 20+.

## Usage

```bash
openchamber                          # Start on port 3000
openchamber --port 8080              # Custom port
openchamber --ui-password secret     # Password-protect UI
openchamber tunnel help              # Tunnel lifecycle commands
openchamber tunnel providers         # Show provider capabilities
openchamber tunnel profile add --provider cloudflare --mode managed-remote --name prod-main --hostname app.example.com --token <token>
openchamber tunnel start --profile prod-main
openchamber tunnel start --provider cloudflare --mode quick --qr
openchamber tunnel start --provider cloudflare --mode managed-local --config ~/.cloudflared/config.yml
openchamber tunnel status --all      # Show tunnel state across instances
openchamber tunnel stop --port 3000  # Stop tunnel only (server stays running)
openchamber logs                     # Follow latest instance logs
OPENCODE_PORT=4096 OPENCODE_SKIP_START=true openchamber                    # Connect to external OpenCode server
OPENCODE_HOST=https://myhost:4096 OPENCODE_SKIP_START=true openchamber  # Connect via custom host/HTTPS
openchamber stop                     # Stop server
openchamber update                   # Update to latest version
```

### Tunnel behavior notes

- One active tunnel per running OpenChamber instance (port).
- Starting a different tunnel mode/provider on the same instance replaces the active tunnel.
- Replacing or stopping a tunnel revokes existing connect links and invalidates remote tunnel sessions.
- Connect links are one-time tokens; generating a new link revokes the previous unused link.

<details>
<summary>Connect to external OpenCode server</summary>

```bash
OPENCODE_PORT=4096 OPENCODE_SKIP_START=true openchamber
OPENCODE_HOST=https://myhost:4096 OPENCODE_SKIP_START=true openchamber
```

| Variable | Description |
|----------|-------------|
| `OPENCODE_HOST` | Full base URL of external server (overrides `OPENCODE_PORT`) |
| `OPENCODE_PORT` | Port of external server |
| `OPENCODE_SKIP_START` | Skip starting embedded OpenCode server |
| `OPENCHAMBER_OPENCODE_HOSTNAME` | Bind hostname for managed OpenCode server (default: `127.0.0.1`, use `0.0.0.0` for LAN/remote access — trusted networks only) |
| `OPENCHAMBER_HOST` | Bind hostname for the OpenChamber web server (default: `127.0.0.1`; use `0.0.0.0` for LAN/remote access — trusted networks only) |
| `OPENCHAMBER_VERBOSE_REQUEST_LOGS` | Set to `true` to log every HTTP request; disabled by default to keep user logs small |
| `OPENCHAMBER_SKIP_API_COMPRESSION` | Set to `true` to disable gzip compression for `/api/*` responses |
| `OPENCHAMBER_COMPRESS_API` | Set to `true` to force `/api/*` compression, or `false` to disable it. Desktop runtime disables API compression by default to reduce local sidecar CPU use |

</details>

<details>
<summary>Bind managed OpenCode to LAN / Tailscale</summary>

```bash
OPENCHAMBER_OPENCODE_HOSTNAME=0.0.0.0 openchamber --port 3000
```

**Security note:** binding to `0.0.0.0` exposes the server on all network interfaces — use only on trusted networks and protect with firewall rules or `--ui-password`.

</details>

**Optional env vars:**
```yaml
environment:
  UI_PASSWORD: your_secure_password
  OPENCHAMBER_TUNNEL_MODE: quick # quick | managed-remote | managed-local
  OPENCHAMBER_TUNNEL_PROVIDER: cloudflare
```

For `managed-remote` mode, also set:

```yaml
environment:
  OPENCHAMBER_TUNNEL_MODE: managed-remote
  OPENCHAMBER_TUNNEL_HOSTNAME: app.example.com
  OPENCHAMBER_TUNNEL_TOKEN: <token>
```

For `managed-local` mode, you can set:

```yaml
environment:
  OPENCHAMBER_TUNNEL_MODE: managed-local
  OPENCHAMBER_TUNNEL_CONFIG: /home/openchamber/.cloudflared/config.yml
```

Managed-local path note: `OPENCHAMBER_TUNNEL_CONFIG` must use a container path under `/home/openchamber/...`. If the config file references `credentials-file`, ensure that JSON path is also mounted and reachable inside the container.

**Data directory:** mount `data/` for persistent storage. Ensure permissions:
```bash
mkdir -p data/openchamber data/opencode/share data/opencode/config data/ssh
chown -R 1000:1000 data/
```

</details>

<details>
<summary>Background & daemon mode</summary>

```bash
openchamber             # Runs in background by default
openchamber stop        # Stop background server
```

</details>

<details>
<summary>systemd service (VPN / LAN access)</summary>

Use `--foreground` to keep the CLI process alive so systemd (or any other process manager) can track and restart it. Combine with `OPENCODE_HOST` to connect to an OpenCode instance running as a separate service.

**`~/.config/systemd/user/opencode.service`**
```ini
[Unit]
Description=OpenCode Server

[Service]
Type=simple
ExecStart=opencode serve --port 4095
Environment="PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/YOU/.local/bin:/home/YOU/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
Environment=SSH_AUTH_SOCK=%t/ssh-agent.socket
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

> **Why set `PATH` and `SSH_AUTH_SOCK`?**
> systemd user services start with a minimal environment — no shell profile is sourced.
> Without an explicit `PATH`, OpenCode won't find tools installed via Homebrew, npm, or `~/.local/bin`.
> Without `SSH_AUTH_SOCK`, git operations over SSH (push, pull, clone) will fail.
> `%t` expands to `$XDG_RUNTIME_DIR` (e.g. `/run/user/1000`), where most SSH agents write their socket.

**`~/.config/systemd/user/openchamber.service`**
```ini
[Unit]
Description=OpenChamber Web Server
After=opencode.service

[Service]
Type=simple
ExecStart=openchamber serve --port 3000 --host 0.0.0.0 --ui-password your-password --foreground
Environment="OPENCODE_HOST=http://localhost:4095"
Environment="OPENCODE_SKIP_START=true"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode openchamber
```

`--host 0.0.0.0` is required to listen on all interfaces (the default is `127.0.0.1`). Use `--host <ip>` or `OPENCHAMBER_HOST=<ip>` to bind to a specific interface instead.

</details>

## What makes the web version special

- **Remote access** - Cloudflare tunnel with QR onboarding. Scan from your phone, start coding.
- **Mobile-first PWA** - optimized chat controls, keyboard-safe layouts, drag-to-reorder projects
- **Background notifications** - know when your agent finishes, even from another tab
- **Self-update** - update and restart from the UI, server settings stay intact
- **Cross-tab tracking** - session activity stays in sync across browser tabs

- Cloudflare tunnel access with quick, managed-remote, and managed-local modes
- One-scan onboarding with tunnel QR + password URL helpers
- Mobile-first experience: optimized chat controls, keyboard-safe layouts, and attachment-friendly UI
- Background notifications plus reliable cross-tab session activity tracking
- Built-in self-update + restart flow that keeps your server settings intact

## License

MIT
