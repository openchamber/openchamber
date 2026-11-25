# Manual test in OpenChamber web

These steps run a dev OpenChamber against an OpenCode that loads this plugin, with a throwaway home, config and data under one folder `D`. Nothing reads or writes `~/.config/opencode`, `~/.local/share/opencode`, `~/.config/openchamber` or `~/.gemini`. The one thing that needs a person is the Google sign-in in step 5.

OpenCode runs as a separate process here, so its stderr, where the plugin's debug lines go, lands in a log file you can read. OpenChamber connects to it as an external server.

| Process | Port | URL |
| --- | --- | --- |
| OpenCode (`opencode serve`) | 4196 | `http://127.0.0.1:4196` (Basic auth, user `opencode`) |
| OpenChamber API (dev server) | 3912 | `http://localhost:3912` |
| OpenChamber UI (Vite) | 5190 | `http://localhost:5190` (open this one) |

All three ports must be free: `lsof -nP -iTCP:4196,3912,5190 -sTCP:LISTEN` prints nothing.

## 1. Build the plugin

```bash
cd <repo>/plugins/opencode-antigravity
bun run build
```

OpenCode loads `dist/index.js`. Build again after any source change, then restart OpenCode (step 3).

## 2. Make the isolated folder and the OpenCode config

macOS stores real paths, so `D` lives under `/private/tmp`, never `/tmp`.

```bash
export D=/private/tmp/agy-manual
rm -rf "$D" && mkdir -p "$D"/{home,xdg/opencode,data,cache,state,oc,proj,logs}
printf 'The secret word is pelican.\n' > "$D/proj/notes.txt"

# agy binary: T3 Code's copy when it exists (read only), otherwise the plugin downloads it (about 230 MB, once).
AGY_BIN=$(ls -d "$HOME"/.t3/tools/antigravity-acp/*/versions/*/antigravity 2>/dev/null | head -1)
if [ -n "$AGY_BIN" ]; then BIN_OPT=",\"binaryPath\": \"$AGY_BIN\""; else BIN_OPT=""; fi

cat > "$D/xdg/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "<repo>/plugins/opencode-antigravity",
      "options": { "debug": true $BIN_OPT }
    }
  ]
}
EOF
cat "$D/xdg/opencode/opencode.json"
```

`debug: true` logs ids, counts, plans and timings, never prompt text or tool content.

## 3. Start OpenCode

Every inherited `OPENCODE_*`, `OPENCHAMBER_*` and `GIT_*` variable is removed first: a shell opened from the desktop app carries the app's own server settings. `perl ... setsid` starts the process in its own process group, so step 10 can stop all of it.

```bash
cd "$D/proj"
env $(env | grep -oE '^(OPENCODE_|OPENCHAMBER_|GIT_)[A-Z_]*' | sed 's/^/-u /') \
  HOME="$D/home" XDG_CONFIG_HOME="$D/xdg" XDG_DATA_HOME="$D/data" XDG_CACHE_HOME="$D/cache" XDG_STATE_HOME="$D/state" \
  BUN_INSTALL_CACHE_DIR="$D/cache" OPENCODE_SERVER_PASSWORD=agy-manual \
  perl -MPOSIX -e 'setsid(); exec @ARGV' -- /opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 4196 \
  > "$D/logs/opencode.log" 2>&1 &
echo $! > "$D/logs/opencode.pid"
```

Wait until it answers, then check that the plugin registered:

```bash
until curl -sf -u opencode:agy-manual http://127.0.0.1:4196/api/info >/dev/null; do sleep 1; done
curl -s -u opencode:agy-manual -H "x-opencode-directory: $D/proj" http://127.0.0.1:4196/api/provider >/dev/null   # starts the location
sleep 5
curl -s -u opencode:agy-manual -H "x-opencode-directory: $D/proj" http://127.0.0.1:4196/api/integration \
  | python3 -c 'import json,sys; print([i for i in json.load(sys.stdin)["data"] if i["id"]=="antigravity"])'
```

Expected: `[{'id': 'antigravity', 'name': 'Antigravity', 'methods': [{'id': 'oauth-personal', 'type': 'oauth', 'label': 'Sign in with Google'}], 'connections': []}]`.

`$D/logs/opencode.log` must not contain `tool guard hook is off`, and `$D/data/opencode-antigravity/gemini/config/hooks.json` must exist with the key `opencode-bridge-guard`.

A shortcut used below, the plugin's `/health` (its port is random, so read it from OpenCode):

```bash
health() {
  local url
  url=$(curl -s -u opencode:agy-manual -H "x-opencode-directory: $D/proj" http://127.0.0.1:4196/api/provider \
    | python3 -c 'import json,sys
def walk(x):
    if isinstance(x, dict):
        if x.get("id") == "antigravity" and "settings" in x: print(x["settings"]["baseURL"]); raise SystemExit
        for v in x.values(): walk(v)
    elif isinstance(x, list):
        for v in x: walk(v)
walk(json.load(sys.stdin))')
  curl -s "${url%/v1}/health"; echo
}
health
```

Before sign-in it prints `{"ok":true,"acp":"stopped","auth":"unknown",...}` (or `"signed_out"`).

## 4. Start OpenChamber and add the project

```bash
cd <repo>
env $(env | grep -oE '^(OPENCODE_|OPENCHAMBER_|GIT_)[A-Z_]*' | sed 's/^/-u /') \
  HOME="$D/home" XDG_CONFIG_HOME="$D/xdg" XDG_DATA_HOME="$D/data" XDG_CACHE_HOME="$D/cache" XDG_STATE_HOME="$D/state" \
  BUN_INSTALL_CACHE_DIR="$D/cache" OPENCHAMBER_DATA_DIR="$D/oc" \
  OPENCODE_PORT=4196 OPENCODE_SKIP_START=true OPENCODE_SERVER_PASSWORD=agy-manual \
  OPENCHAMBER_HMR_UI_PORT=5190 OPENCHAMBER_HMR_API_PORT=3912 \
  perl -MPOSIX -e 'setsid(); exec @ARGV' -- bun run dev > "$D/logs/openchamber.log" 2>&1 &
echo $! > "$D/logs/openchamber.pid"
until grep -q "IMPORTANT: open UI URL" "$D/logs/openchamber.log"; do sleep 2; done
```

The first start compiles for about 20 seconds; the wait allows up to 2 minutes.

Isolation check, before anything else. This must print `{"data":[],"cursor":{"previous":null,"next":null}}`; any session in `data` means the instance sees real data, so stop at step 10.

```bash
curl -s "http://localhost:3912/api/session?directory=<repo>"; echo
```

Register the project folder (the server answers with the saved settings; the project id becomes a path-based id, which is fine):

```bash
curl -s -X PUT http://localhost:3912/api/config/settings -H 'content-type: application/json' \
  -d "{\"projects\":[{\"id\":\"agy-manual\",\"path\":\"$D/proj\",\"label\":\"agy-manual\"}],\"activeProjectId\":\"agy-manual\"}" >/dev/null
```

Open `http://localhost:5190` in Chrome (use `localhost`, not `127.0.0.1`). If Chrome is started for automation, start it with `--disable-features=MacAppCodeSignClone`. Wait until the page shows the sidebar with the project `agy-manual`.

## 5. Sign in with Google

1. Sidebar footer: click **Settings**. In the settings list, open **Providers** (OpenCode group).
2. **Antigravity** is listed directly on the Providers page, under **Not signed in** (it is not behind **Connect provider**). Open it.
3. Under **Authentication**, the card **Sign in with Google** shows **Not connected**. Click **Connect**.
4. The dialog shows **Authorization link** with **Open** and **Copy**, the text "Sign in with Google in the browser tab that opened. Antigravity then shows an authorization code. Copy the code, or that page's full address, and paste it below.", and an input with the placeholder **Paste authorization code**.
5. A person does this part: open the link, sign in with a Google account that has Antigravity access, and copy the code that `antigravity.google/oauth-callback` shows (or that page's address).
6. Paste it into **Paste authorization code** and click **Complete**. The button reads **Saving...** for a few seconds.

Expected:

- The card shows the account under **Accounts** as **Signed in**, labelled `Google (<email>)`.
- `health` prints `"auth":"signed_in"`.
- `ls "$D/data/opencode-antigravity/gemini/antigravity-acp"` lists token files there; nothing new appears in `~/.gemini`. Do not print the token files.

A failed paste shows **Try again**; a second attempt starts a new link.

## 6. A chat turn

1. Sidebar header: **New session** (or `Cmd+N`) in project `agy-manual`.
2. In the composer, click the model button (**Select model** or the current model's name) and type `Antigravity` in **Search models**. Pick a model this account really offers:
   - Until agy has run once, the picker shows the plugin's built-in list, which can name models the account lacks. Such a model answers "This Antigravity account has no model "<id>". Pick another Antigravity model." and is not retried.
   - After the first turn, the plugin reads the account's catalog; reopen the picker to see it. The ids it read are in the cache: `python3 -c 'import json,sys; print([m["id"] for m in json.load(open(sys.argv[1]))["models"]])' "$D/data/opencode-antigravity/models.json"`.
   - On the account used for the live test, `Gemini 4 Hydrogen` (agy's default) worked; `Gemini 3.8 Flash` was often out of capacity.
3. Type `Reply with exactly: hello from antigravity` and press Enter (**Send message**).

Expected:

- The reply streams in; reasoning may show first. The first turn after a cold start can take 10 to 30 seconds while agy starts; a note "[Antigravity] Starting Antigravity CLI..." can appear in the reasoning.
- `grep "plan " "$D/logs/opencode.log" | tail -1` shows `plan fresh (no-binding)`. The session title comes from a separate meta request with no plan line of its own, so `session/prompt blocks=` lines can outnumber plan lines; count only plan lines.
- `health` prints `"acp":"ready"`.
- If Google has no capacity or rate-limits the model, agy retries on its own and the reasoning shows `[Antigravity] Google answered HTTP 503 ...` notes. When its retries run out, the chat ends with "..., and Antigravity already retried on its own. Request limit exhausted for now: try again later or pick another model." OpenCode does not start a second round of retries. Pick another model and send again.

Note the session's binding (one file per OpenCode session; it holds ids and hashes only):

```bash
bindings() {
  for f in "$D"/data/opencode-antigravity/sessions/v1/*/*.json; do
    python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["sessionKey"], r["acpSessionId"], "turns=%d" % r["turns"], r["state"], (r["lastTurn"] or {}).get("plan"))' "$f"
  done
}
bindings
```

Expected: one line, `turns=1`, plan `fresh`. Write down the `acpSessionId`.

## 7. A tool call

In the same session send:

`Use the read tool to read notes.txt in this project, then tell me the secret word.`

Expected:

- A tool row for `read` with `notes.txt` appears inside the assistant message. If OpenCode asks for permission, allow it.
- The answer names `pelican`.
- `grep -E "plan |mcp call parked" "$D/logs/opencode.log" | tail -4` shows `plan append`, `mcp call parked (1 open)`, then `plan resume`.
- `bindings`: the same `acpSessionId` as before, `turns=2`.

## 8. A second turn reuses the ACP session

Send `What was the secret word again? One word.`

Expected:

- The answer is `pelican` without a new tool call.
- The log's last plan line is `plan append`; no `plan fresh` since step 6.
- `bindings`: the same `acpSessionId`, `turns=3`, plan `append`.

## 9. An edit opens a fresh ACP session

1. Hover the first user message (`Reply with exactly: hello from antigravity`) and click the revert icon (tooltip **Revert from here**, aria label **Revert to this message**). The messages from there on disappear and the text goes back into the composer.
2. Change it to `Reply with exactly: edited hello` and send.

Expected:

- The reply is `edited hello`.
- The log's last plan line is `plan fresh (prefix-mismatch)`.
- `bindings`: a different `acpSessionId` than before, `turns=1`, plan `fresh`.

Optional, a revert and **Redo** of a later message: also `plan fresh (...)`.

## 10. Sign out, then stop everything

1. **Settings**, **Providers**, **Antigravity**, **Accounts**: open the account's overflow menu (**Actions for Google (<email>)**) and choose **Remove**. The toast **Account removed** appears.
2. Within about 10 seconds, `health` prints `"auth":"signed_out"` and `ls "$D/data/opencode-antigravity/gemini/antigravity-acp"` no longer lists `acp_token.json` or `antigravity-oauth-token`.
3. Send any message in the session. Expected error in the chat: "Sign in to Antigravity in Settings, Providers before using it."
4. Optional: **Connect** again (step 5); chat works again.

Stop and clean up:

```bash
kill -- -"$(cat "$D/logs/openchamber.pid")" 2>/dev/null
kill -- -"$(cat "$D/logs/opencode.pid")" 2>/dev/null
sleep 3
lsof -nP -iTCP:4196,3912,5190 -sTCP:LISTEN   # prints nothing
rm -rf "$D"
```

The plugin stops agy when OpenCode exits. `pgrep -fl "antigravity acp"` should print nothing that points into `$D`.

## What to report

For each step: pass or fail, the log lines and `bindings` output quoted above, and a screenshot of the provider card after steps 5 and 10 and of the chat after steps 7 and 9. Never paste token files, the sign-in code or the authorization link.
