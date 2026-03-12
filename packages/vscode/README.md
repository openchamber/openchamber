# OpenChamber VS Code Extension

[![GitHub stars](https://img.shields.io/github/stars/btriapitsyn/openchamber?style=flat&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgZmlsbD0iI2YxZWNlYyIgdmlld0JveD0iMCAwIDI1NiAyNTYiPjxwYXRoIGQ9Ik0yMjkuMDYsMTA4Ljc5bC00OC43LDQyLDE0Ljg4LDYyLjc5YTguNCw4LjQsMCwwLDEtMTIuNTIsOS4xN0wxMjgsMTg5LjA5LDczLjI4LDIyMi43NGE4LjQsOC40LDAsMCwxLTEyLjUyLTkuMTdsMTQuODgtNjIuNzktNDguNy00MkE4LjQ2LDguNDYsMCwwLDEsMzEuNzMsOTRMOTUuNjQsODguOGwyNC42Mi01OS42YTguMzYsOC4zNiwwLDAsMSwxNS40OCwwbDI0LjYyLDU5LjZMMjI0LjI3LDk0QTguNDYsOC40NiwwLDAsMSwyMjkuMDYsMTA4Ljc5WiIgb3BhY2l0eT0iMC4yIj48L3BhdGg%2BPHBhdGggZD0iTTIzOS4xOCw5Ny4yNkExNi4zOCwxNi4zOCwwLDAsMCwyMjQuOTIsODZsLTU5LTQuNzZMMTQzLjE0LDI2LjE1YTE2LjM2LDE2LjM2LDAsMCwwLTMwLjI3LDBMOTAuMTEsODEuMjMsMzEuMDgsODZhMTYuNDYsMTYuNDYsMCwwLDAtOS4zNywyOC44Nmw0NSwzOC44M0w1MywyMTEuNzVhMTYuMzgsMTYuMzgsMCwwLDAsMjQuNSwxNy44MkwxMjgsMTk4LjQ5bDUwLjUzLDMxLjA4QTE2LjQsMTYuNCwwLDAsMCwyMDMsMjExLjc1bC0xMy43Ni01OC4wNyw0NS0zOC44M0ExNi40MywxNi40MywwLDAsMCwyMzkuMTgsOTcuMjZabS0xNS4zNCw1LjQ3LTQ4LjcsNDJhOCw4LDAsMCwwLTIuNTYsNy45MWwxNC44OCw2Mi44YS4zNy4zNywwLDAsMS0uMTcuNDhjLS4xOC4xNC0uMjMuMTEtLjM4LDBsLTU0LjcyLTMzLjY1YTgsOCwwLDAsMC04LjM4LDBMNjkuMDksMjE1Ljk0Yy0uMTUuMDktLjE5LjEyLS4zOCwwYS4zNy4zNywwLDAsMS0uMTctLjQ4bDE0Ljg4LTYyLjhhOCw4LDAsMCwwLTIuNTYtNy45MWwtNDguNy00MmMtLjEyLS4xLS4yMy0uMTktLjEzLS41cy4xOC0uMjcuMzMtLjI5bDYzLjkyLTUuMTZBOCw4LDAsMCwwLDEwMyw5MS44NmwyNC42Mi01OS42MWMuMDgtLjE3LjExLS4yNS4zNS0uMjVzLjI3LjA4LjM1LjI1TDE1Myw5MS44NmE4LDgsMCwwLDAsNi43NSw0LjkybDYzLjkyLDUuMTZjLjE1LDAsLjI0LDAsLjMzLjI5UzIyNCwxMDIuNjMsMjIzLjg0LDEwMi43M1oiPjwvcGF0aD48L3N2Zz4%3D&logoColor=FFFCF0&labelColor=100F0F&color=66800B)](https://github.com/btriapitsyn/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/btriapitsyn/openchamber?style=flat&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgZmlsbD0iI2YxZWNlYyIgdmlld0JveD0iMCAwIDI1NiAyNTYiPjxwYXRoIGQ9Ik0xMjgsMTI5LjA5VjIzMmE4LDgsMCwwLDEtMy44NC0xbC04OC00OC4xOGE4LDgsMCwwLDEtNC4xNi03VjgwLjE4YTgsOCwwLDAsMSwuNy0zLjI1WiIgb3BhY2l0eT0iMC4yIj48L3BhdGg%2BPHBhdGggZD0iTTIyMy42OCw2Ni4xNSwxMzUuNjgsMThhMTUuODgsMTUuODgsMCwwLDAtMTUuMzYsMGwtODgsNDguMTdhMTYsMTYsMCwwLDAtOC4zMiwxNHY5NS42NGExNiwxNiwwLDAsMCw4LjMyLDE0bDg4LDQ4LjE3YTE1Ljg4LDE1Ljg4LDAsMCwwLDE1LjM2LDBsODgtNDguMTdhMTYsMTYsMCwwLDAsOC4zMi0xNFY4MC4xOEExNiwxNiwwLDAsMCwyMjMuNjgsNjYuMTVaTTEyOCwzMmw4MC4zNCw0NC0yOS43NywxNi4zLTgwLjM1LTQ0Wk0xMjgsMTIwLDQ3LjY2LDc2bDMzLjktMTguNTYsODAuMzQsNDRaTTQwLDkwbDgwLDQzLjc4djg1Ljc5TDQwLDE3NS44MlptMTc2LDg1Ljc4aDBsLTgwLDQzLjc5VjEzMy44MmwzMi0xNy41MVYxNTJhOCw4LDAsMCwwLDE2LDBWMTA3LjU1TDIxNiw5MHY4NS43N1oiPjwvcGF0aD48L3N2Zz4%3D&logoColor=FFFCF0&labelColor=100F0F&color=205EA6)](https://github.com/btriapitsyn/openchamber/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-join.png?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![Support the project](https://img.shields.io/badge/Support-Project-black?style=flat&labelColor=100F0F&color=EC8B49&logo=ko-fi&logoColor=FFFCF0)](https://ko-fi.com/G2G41SAWNS)

[OpenCode](https://opencode.ai) AI coding agent, right inside your editor. No tab-switching, no context loss.

![VS Code Extension](https://github.com/btriapitsyn/openchamber/raw/HEAD/packages/vscode/extension.jpg)

**Like the extension? There's also a [desktop app and web version](https://github.com/btriapitsyn/openchamber) with even more features.**

## What you get

- **Chat beside your code** — responsive layout that adapts to narrow and wide panels
- **Agent Manager** — run the same prompt across multiple models in parallel, compare results side by side
- **Right-click actions** — add context, explain selections, and improve code in-place
- **Click-to-open** — file paths in tool output open directly in your editor; edit-style results land in a focused diff view
- **Session editor panel** — keep chat sessions open alongside files
- **Theme-aware** — adapts to your VS Code light, dark, and high-contrast themes

Plus everything from the shared OpenChamber UI: branchable timeline, smart tool UIs, voice mode, Git workflows, and more.

## Commands

| Command | Description |
|---------|-------------|
| `OpenChamber: Focus Chat` | Focus the chat panel |
| `OpenChamber: New Session` | Start a new chat session |
| `OpenChamber: Open Sidebar` | Open the OpenChamber sidebar |
| `OpenChamber: Open Agent Manager` | Launch parallel multi-model runs |
| `OpenChamber: Open Session in Editor` | Open current or new session in an editor tab |
| `OpenChamber: Settings` | Open extension settings |
| `OpenChamber: Restart API Connection` | Restart the OpenCode API process |
| `OpenChamber: Show OpenCode Status` | Debug info for development or bug reports |

### Right-click menu

Select code in the editor, right-click, and find the **OpenChamber** submenu:

| Action | Description |
|--------|-------------|
| Add to Context | Attach selection to your next prompt |
| Explain | Ask the agent to explain the selected code |
| Improve Code | Ask the agent to improve the selection in-place |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `openchamber.apiUrl` | _(empty)_ | URL of an external OpenCode API server. Leave empty to auto-start a local instance. |
| `openchamber.opencodeBinary` | _(empty)_ | Absolute path to the `opencode` CLI binary. Useful when PATH lookup fails. Requires window reload to apply. |

## Requirements

- [OpenCode CLI](https://opencode.ai) installed and available in PATH (or set `OPENCODE_BINARY` env var)
- VS Code 1.85+

<details>
<summary>Development</summary>

```bash
bun install
bun run --cwd packages/vscode build
cd packages/vscode && bunx vsce package --no-dependencies
```

Install locally: `code --install-extension packages/vscode/openchamber-*.vsix`

</details>

## License

MIT
