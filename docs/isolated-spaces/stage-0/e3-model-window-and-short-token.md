# E3: model window and the short OpenAI token

Run on 2026-09-19. Colima, Docker 29.2.1, linux/arm64. OpenCode `1.18.31` from `npm i -g opencode-ai`. The local source checkout is 1.17.17. Every key and token was fake. Every claim is marked "tried" or "reasoned".

## Verdict

- **Part 1, window. Works.** One turn completed through the window for a custom provider and for the built-in `openai` and `anthropic` ids. The fake upstream saw only the gatekeeper's key.
- **Part 2, corridor. Works with changes.** OpenCode, curl, npm and git honour the proxy env. Plain Node and ssh ignore it and fail. The space needs `NO_PROXY=gatekeeper` and two OpenCode env flags.
- **Part 3, short token. Works with changes.** A fake record with a future `expires` goes straight to `chatgpt.com` and never touches `auth.openai.com`. Push tokens with `PUT /auth/openai`. Never use `OPENCODE_AUTH_CONTENT`. If the first token arrives after a project instance loaded, also call `POST /instance/dispose`.

## What I ran

The scratch files were temporary and are not kept. `gk/` held `window.js`, `corridor.js`, `upstream.js`, the allowlists and a Dockerfile. `space/` holds the Dockerfile, both `opencode.json` files and the test scripts `turn.sh`, `prove.sh`, `trace.sh`, `dnsnames.py`, `serve-trace.sh`, `corridor-clients.sh`, `p3.sh`.

```
docker build -t oc-s0-e3-gk gk ; docker build -t oc-s0-e3-space space
docker network create --internal oc-s0-e3-inner ; docker network create oc-s0-e3-outer
docker run -d --name oc-s0-e3-upstream --network oc-s0-e3-outer oc-s0-e3-gk node /gk/upstream.js
docker run -d --name oc-s0-e3-gatekeeper --network oc-s0-e3-inner --network-alias gatekeeper oc-s0-e3-gk
docker network connect oc-s0-e3-outer oc-s0-e3-gatekeeper
docker run -d --name oc-s0-e3-space --network oc-s0-e3-inner --cap-drop ALL --security-opt no-new-privileges oc-s0-e3-space
docker exec -d oc-s0-e3-gatekeeper sh -c 'mkfifo /gk/grants.fifo; while true; do cat /gk/grants.fifo; done | node /gk/window.js > /gk/window.log 2>&1'
docker exec -d oc-s0-e3-gatekeeper sh -c 'node /gk/corridor.js > /gk/corridor.log 2>&1'
printf '%s\n' '{"fakeai":{"upstream":"http://oc-s0-e3-upstream:9000/v1","header":"authorization","key":"sk-REAL-held-by-gatekeeper"}, ...}' | docker exec -i oc-s0-e3-gatekeeper sh -c 'cat > /gk/grants.fifo'
docker exec oc-s0-e3-space bash /tmp/turn.sh fakeai/fake-1        # also openai/gpt-5.4-mini, anthropic/claude-haiku-4-5
docker exec oc-s0-e3-space bash /tmp/prove.sh 172.19.0.2
docker exec -e HTTPS_PROXY=http://gatekeeper:3128 -e HTTP_PROXY=http://gatekeeper:3128 -e NO_PROXY=gatekeeper,localhost,127.0.0.1 oc-s0-e3-space bash /tmp/corridor-clients.sh
docker exec <same proxy env> -e OPENCODE_DISABLE_MODELS_FETCH=1 -e OPENCODE_DISABLE_AUTOUPDATE=1 oc-s0-e3-space bash /tmp/p3.sh file-fresh   # then file-stale, env-vs-put, put-live, put-first, put-late
```

The space image is `node:22-bookworm` plus `opencode-ai`, `strace`, and a non-root `agent` user. Files went in with `docker cp`. `upstream.js` (42 lines) answers `/chat/completions`, `/responses` and `/messages` with canned streams and logs the auth headers. The window, shortened only in its logging:

```js
const http = require('http')
let grants = {}, buf = ''   // grants arrive as JSON lines on stdin: never in env, argv, or on disk
process.stdin.on('data', (c) => { buf += c; let i
  while ((i = buf.indexOf('\n')) >= 0) { try { grants = { ...grants, ...JSON.parse(buf.slice(0, i)) } } catch {} buf = buf.slice(i + 1) } })
http.createServer((req, res) => {
  const m = req.url.match(/^\/model\/([^/]+)(\/.*)?$/), g = m && grants[m[1]]
  console.log(JSON.stringify({ window: m && m[1], decision: g ? 'allow' : 'deny' }))
  if (!g) { res.writeHead(403); return res.end('{"error":"no grant"}') }
  const up = new URL(g.upstream), headers = { ...req.headers, host: up.host }
  delete headers.authorization; delete headers['x-api-key']
  headers[g.header] = g.header === 'authorization' ? `Bearer ${g.key}` : g.key
  const out = http.request({ host: up.hostname, port: up.port, method: req.method,
    path: up.pathname.replace(/\/$/, '') + (m[2] || ''), headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  out.on('error', (e) => { res.writeHead(502); res.end(String(e)) }); req.pipe(out)
}).listen(8080)
```

The corridor:

```js
const http = require('http'), net = require('net'), fs = require('fs')
const allowed = () => fs.readFileSync('/gk/allowlist.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }))
const srv = http.createServer((req, res) => { log({ kind: 'http', decision: 'deny' }); res.writeHead(403); res.end() })
srv.on('connect', (req, sock) => {
  sock.on('error', () => {})   // without this, a client reset after a deny crashed the corridor
  const [host, port] = req.url.split(':'), ok = allowed().includes(host) && port === '443'
  log({ kind: 'connect', host, port, ua: req.headers['user-agent'], decision: ok ? 'allow' : 'deny' })
  if (!ok) return sock.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  const up = net.connect(443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up) })
  up.on('error', () => sock.destroy()); sock.on('close', () => up.destroy())
})
srv.listen(3128)
```

## Findings

### Part 1, window

- Tried. This config works. The custom provider needs `npm` and `models`. The built-in ids need only `options`.

```json
{ "$schema": "https://opencode.ai/config.json",
  "model": "fakeai/fake-1", "small_model": "fakeai/fake-1",
  "provider": {
    "fakeai": { "npm": "@ai-sdk/openai-compatible", "name": "Fake AI",
      "options": { "baseURL": "http://gatekeeper:8080/model/fakeai", "apiKey": "sk-fake-inside" },
      "models": { "fake-1": { "name": "Fake 1" } } },
    "openai":    { "options": { "baseURL": "http://gatekeeper:8080/model/openai",    "apiKey": "sk-fake-inside" } },
    "anthropic": { "options": { "baseURL": "http://gatekeeper:8080/model/anthropic", "apiKey": "sk-fake-inside" } } } }
```

- Tried. `opencode run "say hi"` printed `hi from fake upstream` for all three. First run 5.4 s, later runs 1.6 to 1.9 s.
- Tried. Upstream log: `/v1/chat/completions` and `/v1/responses` with `Bearer sk-REAL-held-by-gatekeeper`, `/v1/messages` with `x-api-key: sk-REAL-held-by-gatekeeper`. The window log shows the space sent `sk-fake-inside` each time. The upstream never saw it.
- Tried. With no stored auth entry the built-in `openai` plugin stays out of the way. The request kept the config base URL and went to the window. `openai` uses the Responses API, so the window must pass `/responses`. `anthropic` sends `x-api-key`, so the window needs a per-provider header name.
- Tried. `@ai-sdk/openai-compatible` is bundled in the binary. OpenCode installed nothing from npm for it.
- Tried. In the space, `env`, `ps auxeww`, and a grep over `/home/agent`, `/work` and `/tmp` found no held key. The dummy key is only in `/work/opencode.json`. In the gatekeeper the key is absent from env, files, argv and `docker inspect`. It arrived on `docker exec -i` stdin.
- Tried. From the space, `curl http://172.19.0.2:9000` and `curl https://1.1.1.1` fail at once with "Couldn't connect". `oc-s0-e3-upstream`, `models.dev` and `api.openai.com` do not resolve. The route table has one entry, the internal subnet, and no default route.
- Tried. One small-model call (title) goes out per turn. Point `small_model` at a window model, or it picks one by itself.

### Part 2, corridor

| Client | Honours proxy env | Result (tried) |
|---|---|---|
| OpenCode own fetch (Bun) | yes, `HTTPS_PROXY` | CONNECT to `models.opencode.ai`, `registry.npmjs.org`, `chatgpt.com`, `auth.openai.com` all appear in the corridor log |
| curl, `npm view`, `git ls-remote https://` | yes | 200, `3.0.1`, a HEAD sha. A host off the list gets 403 |
| Node 22 `fetch` and `https.get` | no | `EAI_AGAIN`. With `NODE_USE_ENV_PROXY=1` fetch works |
| ssh to `github.com:22` | no | name resolution fails |

- Tried. `NO_PROXY=gatekeeper,localhost,127.0.0.1` is required. Without it window traffic would go to the corridor as a plain HTTP proxy request, which the corridor denies.
- Tried. My first corridor crashed when a denied client reset the socket. The real one needs an error handler on every socket.
- Reasoned. OpenCode's optional WebSocket path to ChatGPT passes the proxy by hand (`plugin/openai/ws.ts`). It is off by default and I did not test it.

### Part 3, short token

- Tried. Installed 1.18.31 matches the source. Strings from the binary: `if(!M.access||M.expires<Date.now())` then refresh at `https://auth.openai.com/oauth/token`, a hard-coded `chatgpt.com/backend-api/codex/responses`, and `Auth.all` that returns `OPENCODE_AUTH_CONTENT` before reading the file.
- Tried. The record lives at `~/.local/share/opencode/auth.json` (here `/home/agent/...`), mode 0600, shape `{"openai":{"type":"oauth","access":"...","refresh":"...","expires":<ms>,"accountId":"..."}}`.
- Tried. Future `expires`: one CONNECT to `chatgpt.com`, none to `auth.openai.com`. The user sees `Error: Unauthorized: {"detail":"Could not parse your authentication token..."}`. That is the real backend rejecting the fake token, as expected.
- Tried. Past `expires`, dummy refresh: exactly one CONNECT to `auth.openai.com`, no call to `chatgpt.com`, no retry loop, exit 1 in about 2 s. The user sees `Error: Token refresh failed: 401` when the host is allowed and `Token refresh failed: 403` when the corridor denies it. `auth.json` stays unchanged.
- Tried. `PUT /auth/openai` on a running `opencode serve` returns `true`, rewrites `auth.json`, and the next turn uses the new token with no restart. Overwriting `auth.json` by hand also takes effect on the next request, because the plugin re-reads the record per request.
- Tried. `OPENCODE_AUTH_CONTENT` wins over everything. I started serve with a stale record in the env and pushed a fresh one with PUT. The file got the fresh record, and the turn still called `auth.openai.com`. Writes are invisible until restart.
- Tried. A trap. If a project instance loaded while no `openai` record existed, a later PUT does not add the OpenAI login models. The turn fails with "Unexpected server error". `POST /instance/dispose?directory=/work` fixes it and the next turn reaches `chatgpt.com`. Replacing an existing record needs no dispose.
- Tried. `opencode run --attach` exits 0 and prints nothing when the provider call fails. Read errors from session events, never from the exit code.

## Startup fetches

| Host | Purpose | When blocked (tried) | How to disable |
|---|---|---|---|
| `models.opencode.ai/api.json` (source default says `models.dev`) | model catalog, at start and hourly | fails in under 1 s, one ERROR log line, the embedded catalog is used, no hang | `OPENCODE_DISABLE_MODELS_FETCH=1` (tried, zero lookups). `OPENCODE_MODELS_URL` or `OPENCODE_MODELS_PATH` to point elsewhere (reasoned) |
| `registry.npmjs.org` | update check, and a background install of `@opencode-ai/plugin` into config dirs (reasoned from source) | fails silently, no delay. Seen on most runs but not all | `OPENCODE_DISABLE_AUTOUPDATE=1` removed it in one traced run, yet attempts still showed in later corridor logs. `"autoupdate": false` in config did not stop it. Not pinned down |
| share, telemetry | none observed in any trace | | `"share": "disabled"` set anyway |
| LSP and formatter downloads | on first use of a file type (reasoned) | not triggered | `OPENCODE_DISABLE_LSP_DOWNLOAD=1` exists in source |

With both env flags set, `opencode serve` asked DNS for `gatekeeper` only and was healthy after about 1 s (tried).

## What this changes in DESIGN.md

- Gatekeeper, window. Add that the header is per provider (`Authorization: Bearer` or `x-api-key`), and that the path is passed through unchanged. Plain HTTP between space and gatekeeper works with OpenCode.
- Gatekeeper, corridor. Add the required space env: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY=<gatekeeper name>`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`. Add `NODE_USE_ENV_PROXY=1` so the agent's own Node scripts can use the corridor. Tools that ignore proxy env fail, which the boundary rule wants.
- The "login record for the short OpenAI token" touch point is `PUT /auth/openai` on the space's OpenCode, sent over `exec` with curl to loopback, plus `POST /instance/dispose` when it is the first record. State that `OPENCODE_AUTH_CONTENT` is forbidden in spaces.
- The OpenAI preset allowlist is `chatgpt.com` only. Leave `auth.openai.com` off. A late host refresh then shows up as a clean "Token refresh failed" and the space can never rotate the user's refresh token.
- LESSONS.md "Provider logins" holds as written. Add the `models.opencode.ai` host name and the env-var trap.

## Not verified

- A real token, real completions, and the ChatGPT WebSocket mode.
- TLS from the window to a real upstream. My upstream was plain HTTP.
- Whether `opencode.json` `options.baseURL` on `openai` conflicts with an oauth record for the same id.
- Which code path makes the leftover `registry.npmjs.org` attempts.
- The exact refresh payload. With a dummy refresh string the real issuer answers 401.
- OpenChamber server in the space, Copilot, git URL rewrite and the npm registry window.
- `serve` under `strace` with proxy env was slow to answer health checks. I dropped strace there and did not look further.

Cleanup: all `oc-s0-e3-` containers, networks and images removed. The filtered `docker ps -a`, `docker network ls` and `docker volume ls` outputs were empty.
