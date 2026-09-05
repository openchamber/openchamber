# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/openchamber-logo-dark.svg"><img src="docs/references/badges/openchamber-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> OpenChamber

[![GitHub stars](https://img.shields.io/github/stars/openchamber/openchamber?style=flat&labelColor=100F0F&color=66800B)](https://github.com/openchamber/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/openchamber/openchamber?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/openchamber/openchamber/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![Support the project](https://img.shields.io/badge/Support-Project-black?style=flat&labelColor=100F0F&color=EC8B49&logo=patreon&logoColor=FFFCF0)](https://www.patreon.com/openchamber)

## Run agent work. Keep control. Ship from anywhere.

**OpenChamber is an open-source workspace for running and reviewing AI coding work on desktop, web, VS Code, and mobile.**

Start agent work, see what changed, and take it through review and release. Your projects and sessions remain available when you switch devices or step away.

![OpenChamber Chat](docs/references/chat_example.png)

<details>
<summary>More screenshots</summary>

![VS Code Extension](packages/vscode/extension.jpg)

<p>
<img src="docs/references/pwa_chat_example.png" width="45%" alt="OpenChamber PWA chat">
<img src="docs/references/pwa_diff_example.png" width="45%" alt="OpenChamber PWA diff review">
</p>

</details>

## What you can do with OpenChamber

### Goals that continue on their own

Give a session a finish line with **Session Goals**. OpenChamber checks the result after every turn and keeps the agent working until it completes the goal, gets blocked, or reaches the limit you set. It can continue after you close the app.

### Compare and combine runs

Use **Multi-run** to give the same task to up to five models, each in its own session and optionally its own worktree. See what each one actually built, choose the best result, or use **Fusion** to combine the strongest parts into a new session.

### Guided changes walkthroughs

**Changes Walkthrough** turns a large diff into an AI-guided tour of the change. It groups related edits into steps, puts them in the order the change makes sense, and explains how the pieces fit together.

### Inspect a running app

Open your app beside the conversation with **Preview**. Point at an element to send the agent its screenshot, styles, position, and browser errors. No more trying to explain "this thing here." The desktop app can do the same with any web page in its built-in browser.

### GitHub context from issue to pull request

Start a session from a GitHub issue or pull request with its context attached. Send failed checks or review comments back to the agent, then update or merge the pull request from OpenChamber.

### Continue on another device

Open the same projects and sessions from Desktop, Web/PWA, VS Code, iOS, or Android. Check progress, answer questions, review changes, and reattach to a running terminal.

### Private remote access

Pair a device with a one-time QR code and connect through **Private Relay** without opening ports or exposing a public server. The connection is end-to-end encrypted and can be revoked at any time. Direct connections, LAN/VPN access, Cloudflare/Ngrok tunnels, and SSH are also supported.

### Track work across projects

See which sessions are working, waiting, finished, or failed, along with approvals, scheduled tasks, provider limits, token use, and costs. Organize sessions into folders and keep notes, todos, and reusable project actions nearby.

### Schedule recurring work

Run a prompt once, daily, weekly, or on a cron schedule. Scheduled tasks can use Session Goals, so they continue toward an outcome instead of stopping after one response.

## Use it where you work

| Surface | Role |
| --- | --- |
| **Desktop** | The complete workspace for macOS, Windows, and Linux, with multiple windows, Mini Chat, remote machines, SSH, and native notifications |
| **Web / PWA** | Open your workspace in a browser, install it as an app, and stay up to date through background notifications |
| **VS Code** | Keep sessions beside your code, send selections to the agent, open results in the editor, and compare parallel runs |
| **iOS / Android** | Review and steer work away from your desk, receive completion alerts, and use the terminal with touch controls |
| **CLI / Server** | Run OpenChamber on a workstation or server, schedule work, manage remote access, and keep it available after login |

## Quick start

### Desktop for macOS, Windows, and Linux

Download the latest release from [GitHub Releases](https://github.com/openchamber/openchamber/releases/latest). Desktop bundles the matching OpenCode CLI, so no separate OpenCode installation is required.

Linux releases are available as x86_64 and ARM64 AppImages. Make the downloaded AppImage executable and keep it in a writable location for in-app updates:

```bash
chmod +x OpenChamber-*.AppImage
./OpenChamber-*.AppImage
```

Linux AppImages require FUSE (`libfuse.so.2`). Without FUSE, run with `APPIMAGE_EXTRACT_AND_RUN=1`.

### VS Code

Install [OpenChamber from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber), or search for "OpenChamber" in Extensions.

### CLI for Web and PWA

Requires Node.js 22+. CLI/Web and VS Code use your installed [OpenCode CLI](https://opencode.ai).

```bash
curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash
openchamber --ui-password be-creative-here
```

Common operations:

```bash
openchamber status
openchamber connect-url --qr
openchamber tunnel start --provider cloudflare --mode quick --qr
openchamber startup enable
openchamber logs
openchamber stop
openchamber update
```

OpenChamber binds to localhost by default. Use `--lan` only on a trusted network and protect browser access with `--ui-password`.

## Guides

Go deeper with the OpenChamber guides:

- [Quick start](packages/docs/content/docs/quickstart.mdx)
- [Installation](packages/docs/content/docs/install.mdx)
- [Connect devices](packages/docs/content/docs/connect-devices.mdx)
- [Private Relay](packages/docs/content/docs/private-relay.mdx)
- [Multi-run](packages/docs/content/docs/multi-run.mdx)
- [Session Goals](packages/docs/content/docs/session-goals.mdx)
- [Changes Walkthrough](packages/docs/content/docs/walkthrough.mdx)
- [Preview and dev servers](packages/docs/content/docs/preview.mdx)
- [GitHub workflows](packages/docs/content/docs/github.mdx)
- [Mobile](packages/docs/content/docs/mobile.mdx)
- [Security](packages/docs/content/docs/security.mdx)
- [Troubleshooting](packages/docs/content/docs/troubleshooting.mdx)

For self-hosting details, see the [reverse proxy guide](docs/REVERSE_PROXY.md). For custom theme authoring, see the [custom themes guide](docs/CUSTOM_THEMES.md).

## Why OpenCode?

OpenChamber uses [OpenCode](https://opencode.ai) to run coding agents. We chose it because it is open source, has a solid API, and is easy to extend.

OpenChamber handles the rest of the workflow. You can decide what to try, keep the agent on track, review the result, connect from another device, and ship the change.

OpenChamber is an independent project and is not affiliated with the OpenCode team.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines. Documentation authoring guidance lives in [`packages/docs`](packages/docs/README.md).

## Acknowledgments

Special thanks to:

- [OpenCode](https://opencode.ai) for the API and open-source architecture OpenChamber builds on
- [Pierre](https://pierrejs-docs.vercel.app/) for the diff viewer and syntax highlighting
- [Ghostty-web](https://github.com/coder/ghostty-web) for its Ghostty web renderer
- [Yulia Ivashko](https://github.com/yulia-ivashko), who built the firework celebration that plays on every successful push
- Everyone who contributed code, reported bugs, or shared ideas

## License

MIT
