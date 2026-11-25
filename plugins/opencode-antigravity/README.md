# @openchamber/opencode-antigravity

An OpenCode 2.x provider plugin for Google's Antigravity CLI (`agy`). OpenCode talks to it as an OpenAI-compatible provider named Antigravity; the plugin runs one `agy acp` process, signs in with Google through agy, and sends every tool call back to OpenCode, which runs it under its own permissions.

Design: `docs/architecture.md`, with details in `docs/design-install-auth.md` and `docs/design-sessions-runtime.md`. Locked decisions are in `docs/decisions.md`.

## What it does

- **Binary.** Downloads agy from Google's release manifest into the plugin's data dir, checks its SHA-512 and identity, and updates it in the background every 6 hours. `binaryPath` or `OPENCODE_ANTIGRAVITY_BIN` points at an existing executable instead; `binarySource: "path"` or `"t3code"` uses agy from `PATH` or from T3 Code's cache.
- **Sign-in.** Registers the integration `antigravity` with one method, `oauth-personal` ("Sign in with Google"). Connect opens Google's sign-in page; the code you paste back goes to `agy acp --login`. Tokens stay in the plugin's own agy profile (`isolatedAuth`), never in `~/.gemini`. Removing the last Antigravity account in OpenCode signs agy out.
- **Provider.** Registers provider `antigravity` with the models agy offers (cached, refreshed from agy once a day) and their thinking levels as variants. The provider has no API key; OpenCode sends the marker credential it got at sign-in, and the local proxy refuses chat requests without it.
- **Sessions.** One OpenCode session maps to one ACP session. A turn that only adds messages reuses it, so agy keeps its own context. An edit, revert, fork, compaction or tool-set change opens a fresh ACP session with a structured replay of the history. A change to tool descriptions only keeps the session and adds a note to the next prompt. Bindings persist, so after a restart the plugin resumes the ACP session with `session/resume` and falls back to a replay when agy no longer knows it.
- **Tools.** agy runs a custom agent with no built-in tools. OpenCode's tools reach the model through one MCP server per ACP session on the proxy; a `PreToolUse` hook and the ACP permission check let only those calls through. When the model calls a tool, the response to OpenCode ends with `tool_calls`; the tool result in OpenCode's next request resumes the same ACP prompt.
- **Waiting and failures.** While agy is silent or retrying, status notes go into the reasoning text. A stall cancels the ACP turn and answers a retryable error; quota and sign-in errors are not retried. The process stops after 10 minutes without work and starts again on the next request.

## Configuration

Plugin options go in the `options` object of the plugin entry. A set option wins over its env var, which wins over the default. Durations are milliseconds.

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `binaryPath` | `OPENCODE_ANTIGRAVITY_BIN` | unset | Explicit agy executable; no fallback when it is wrong |
| `binarySource` | `OPENCODE_ANTIGRAVITY_BINARY_SOURCE` | `managed` | `managed`, `path` or `t3code` |
| `autoUpdate` | `OPENCODE_ANTIGRAVITY_AUTO_UPDATE` | `true` | Manifest check every 6 h |
| `offline` | `OPENCODE_ANTIGRAVITY_OFFLINE` | `false` | Never touch the network |
| `offlineFallback` | | `true` | Use `PATH`, then T3 Code's cache, when the managed install is missing and fails |
| `isolatedAuth` | `OPENCODE_ANTIGRAVITY_ISOLATED_AUTH` | `true` | File token storage in the plugin profile |
| `geminiDir` | `OPENCODE_ANTIGRAVITY_GEMINI_DIR` | `<data>/gemini` | agy profile dir (`GEMINI_HOME`) |
| data dir | `OPENCODE_ANTIGRAVITY_DATA_DIR` | `$XDG_DATA_HOME/opencode-antigravity`, else `~/.local/share/opencode-antigravity` | Binaries, profile, session bindings, caches |
| `authMethod` | | `oauth-personal` | The others (`oauth-business`, `gemini-api-key`, `agent-platform`) are reserved: the integration then shows no method and chat answers 401 |
| `auth.gcpProject`, `auth.gcpLocation` | | unset | Reserved for later methods |
| `proxyPort` | `OPENCODE_ANTIGRAVITY_PROXY_PORT` | `0` (random) | Loopback port of the local proxy |
| `idleShutdownMs` | `OPENCODE_ANTIGRAVITY_IDLE_MS` | `600000` | Stop agy after this long without work; `0` never stops it |
| `sessionIdleCloseMs` | | `1800000` | Close a live ACP session unused this long |
| `parkedToolTtlMs` | | `1800000` | Cancel a turn waiting this long for a tool result |
| `cancelSettleMs` | | `15000` | Wait for a cancelled prompt's reply |
| `stallTimeoutMs` | `OPENCODE_ANTIGRAVITY_STALL_MS` | `180000` | Silence without retry evidence before a stall |
| `retryStallTimeoutMs` | | `300000` | Silence while agy logs retries |
| `statusNoteAfterMs` | | `20000` | First waiting note |
| `statusNotes` | | `true` | Status notes in the reasoning text |
| `breakerCooldownMs` | | `30000` | Fail fast after 3 early exits of agy |
| `processPerSession` | | `false` | Pass `--process-per-session` to agy |
| `sessionStore` | | `true` | Persist session bindings |
| `resumeAfterRestart` | | `true` | `session/resume` for bindings from an earlier process |
| `sessionTtlDays` | | `14` | Prune bindings older than this |
| `maxStoredSessions` | | `500` | Prune beyond this many bindings per profile |
| `steering` | | `true` | New user input while a tool runs steers the running prompt |
| `maxSystemPromptBytes` | | `32768` | Budget for OpenCode's system prompt |
| `maxToolsPromptBytes` | | `49152` | Budget for the tool list |
| `replayMaxChars` | | `600000` | Replay cap before the per-model limit |
| `toolGuardHook` | | `true` | `PreToolUse` guard in the plugin's own profile; `false` removes it |
| `debug` | | `false` | Metadata logs to stderr: ids, sizes, counts, timings |
| `debugContent` | | `false` | Also log truncated prompt and tool content |

Env booleans accept `1`, `true`, `yes`, `0`, `false`, `no`, in any case. A bad value keeps the default and logs one line starting with `[opencode-antigravity]`.

## Build and test

```bash
cd plugins/opencode-antigravity
bun run build        # bundles src/ into dist/index.js, which opencode-antigravity.js re-exports
bun run type-check
bun run test         # mock agy only, no network
```

`AGY_SMOKE=1 bun test test/real-agy.smoke.test.ts` runs the opt-in checks against the real agy binary (T3 Code's copy under `~/.t3/tools/antigravity-acp`, else the managed one) in a throwaway profile. `AGY_SMOKE_GEMINI_DIR=<signed-in plugin profile>` adds the steps that need a Google account. `AGY_E2E=1 bun test test/e2e-install.test.ts` downloads the real release into a temp dir.

OpenCode loads `dist/`, so run `bun run build` after every source change.

## Load it into OpenCode

OpenCode 2.x reads plugins from the `plugins` key (plural) of `opencode.json`. A local plugin is its directory; a file path is ignored. Options go in an object, never a tuple:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/abs/path/to/openchamber/plugins/opencode-antigravity",
      "options": { "debug": true }
    }
  ]
}
```

The global config is `$XDG_CONFIG_HOME/opencode/opencode.json` (`~/.config/opencode/opencode.json` by default); a project `opencode.json` works too. Then:

```bash
opencode serve --hostname 127.0.0.1 --port 4196
curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" -H "x-opencode-directory: $PWD" http://127.0.0.1:4196/api/integration
```

The integration list contains `{"id":"antigravity","methods":[{"id":"oauth-personal","type":"oauth","label":"Sign in with Google"}]}`. Without `OPENCODE_SERVER_PASSWORD`, `opencode serve` prints a generated password on its second line. A chat before sign-in fails with "Sign in to Antigravity in Settings, Providers before using it."

## Load it into OpenChamber

OpenChamber starts its own `opencode serve`, and that OpenCode reads the same global `opencode.json`. Add the plugin entry there, or start OpenChamber with `XDG_CONFIG_HOME` pointing at a folder whose `opencode/opencode.json` has it. Then open Settings, Providers, Antigravity and press Connect.

`docs/manual-test.md` has the exact steps for a dev OpenChamber with an isolated home, config and data, so a test run leaves your own OpenCode and OpenChamber settings untouched.
