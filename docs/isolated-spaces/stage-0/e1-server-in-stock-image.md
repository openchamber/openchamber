# E1: OpenChamber server in a stock image

Run on 2026-09-19. Host: macOS, Colima, Docker 29.2.1, linux/arm64. Every claim is marked tried or reasoned.

## Verdict

Works with changes. The published server 1.24.2 installs with npm into a volume, starts from that volume mounted read-only in a hardened `node:22-bookworm` container, and its terminal runs `echo` (tried).
The changes: OpenCode must be in the tools volume because `serve` refuses to start without it, and the container needs an init or the server in the foreground (tried).
A dev build cannot reuse the registry install. The worktree server needs an unreleased `@openchamber/sdk` (tried).

## What I ran

Image: `node:22-bookworm`, pinned as `node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844`. Below, `$IMG` is that reference and `$HARD` is:

```
--user 1000:1000 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m
--cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 2g
-e HOME=/home/node -e OPENCHAMBER_UI_PASSWORD=s0e1-test-pass
```

Path A, one hardened container, install into HOME the way `ssh-manager.mjs` does:

```
docker volume create oc-s0-e1-home-a
docker run -d --name oc-s0-e1-a $HARD --mount type=volume,src=oc-s0-e1-home-a,dst=/home/node \
  -p 127.0.0.1:38411:3000 $IMG sleep infinity
docker exec oc-s0-e1-a npm install -g --prefix /home/node/.openchamber/npm-global @openchamber/web@1.24.2
docker exec oc-s0-e1-a /home/node/.openchamber/npm-global/bin/openchamber serve --host 0.0.0.0 --port 3000   # fails, no opencode
docker exec oc-s0-e1-a npm install -g --prefix /home/node/.openchamber/npm-global opencode-ai@1.18.31
docker exec -e PATH=/home/node/.openchamber/npm-global/bin:/usr/local/bin:/usr/bin:/bin oc-s0-e1-a \
  openchamber serve --host 0.0.0.0 --port 3000
curl http://127.0.0.1:38411/api/system/info        # from the host, 200
docker cp term-test.mjs oc-s0-e1-a:/home/node/ && docker exec oc-s0-e1-a node /home/node/term-test.mjs \
  http://127.0.0.1:3000 s0e1-test-pass <prefix>/lib/node_modules/@openchamber/web/node_modules/ws
```

Then `npm install -g --prefix ... bun@1.3.0` and `serve --port 3001` to exercise the bun path.

Tools volume (step 6):

```
docker volume create oc-s0-e1-tools
docker run --rm --name oc-s0-e1-fill --mount type=volume,src=oc-s0-e1-tools,dst=/opt/oc-tools $IMG \
  npm install -g --prefix /opt/oc-tools --cache /tmp/npm-cache @openchamber/web@1.24.2 opencode-ai@1.18.31
docker run -d --init --name oc-s0-e1-c $HARD -e PATH=/opt/oc-tools/bin:/usr/local/bin:/usr/bin:/bin \
  --mount type=volume,src=oc-s0-e1-tools,dst=/opt/oc-tools,readonly \
  --mount type=volume,src=oc-s0-e1-home-c,dst=/home/node -p 127.0.0.1:38412:3000 \
  $IMG openchamber serve --foreground --host 0.0.0.0 --port 3000
```

The same run again with `--network none` and a fresh HOME volume (`oc-s0-e1-d`).

Path B partial try: copied the tools volume to `oc-s0-e1-tools-b`, then `docker cp` of the worktree's `packages/web/server/.`, `bin/.` and `package.json` over the installed package, then the step 6 run with `--api-only`.

`term-test.mjs` (scratch, not in the repo): `POST /auth/session` with the password, `POST /api/terminal/create` with `{cwd:"/tmp",cols:80,rows:24}`, WebSocket `/api/terminal/ws` with the cookie and a same-host `Origin`, binary frames `0x01 + JSON`: `attach`, then `write` of `echo hello-$((40+2)); tty; id -u\r`.

## Measurements

All tried, linux/arm64, one run each.

| What | Value |
|---|---|
| Image pull, `node:22-bookworm` | 4 min 45 s on this link, 1.63 GB on disk |
| `npm install` of `@openchamber/web@1.24.2` | 17 s, 198 packages, no compiler used |
| Installed size, server only | 201 MB (dist 43, sherpa-onnx 39, openai 28, node-pty 27) |
| `npm install` of `opencode-ai@1.18.31` | 10 s, prefix grows to 377 MB |
| npm cache left in HOME (path A) | 122 MB |
| Both packages into the tools volume, one shot | 31 s, 377 MB |
| `openchamber serve` until ready (daemon mode) | 1.2 s, OpenCode ready within 7 s |
| Memory at idle, whole container | 465 to 525 MB. Server about 160 MB RSS, OpenCode 340 to 500 MB |
| Processes at idle | 25 |
| HOME after first start | `.config/opencode` 63 MB, `.config/openchamber` 64 KB, `.cache` 4.5 MB, `.local` 0.5 MB |
| `/tmp` after first start | 2.6 MB (`node-compile-cache`, `opencode`) |
| `docker stop` with `--init` and `--foreground` | 0.36 s, exit 143 |

## Findings

1. Delivering the server today means a package-manager install on the target (reasoned from code). `installOpenChamberManaged` runs `bun add -g @openchamber/web@<app version>` or `npm install -g --prefix $HOME/.openchamber/npm-global`. `startRemoteServerManaged` requires `opencode` on the remote, sets `OPENCODE_BINARY`, `OPENCHAMBER_RUNTIME=ssh-remote` and `OPENCHAMBER_UI_PASSWORD`, then runs `openchamber serve --hostname <host> --port <port>` as a daemon. It refuses `0.0.0.0` without a password.
2. There is no bundle upload. `uploadBundleOverSsh` is parsed in `desktopSsh.ts` and stored by `ssh-manager.mjs`. Nothing reads it (tried, repo-wide grep). The only bundle that exists is the npm tarball: `dist`, `server`, `bin`, `public`, 47 MB unpacked, 1629 files.
3. The terminal backend follows the runtime (tried). Under node it is `node-pty`, under bun it is `bun-pty`. The snapshot frame reported `runtime node ptyBackend node-pty`, and after installing bun `runtime bun ptyBackend bun-pty`. The CLI daemon picks bun when `bun` is on PATH. `--foreground` runs in the CLI's own runtime.
4. Both pty packages carry prebuilt Linux binaries inside the one package, so no compiler is needed (tried). `node-pty@1.2.0-beta.12` has `prebuilds/linux-arm64` and `linux-x64`, and no `build/Release` appeared after install. `bun-pty@0.4.5` has `librust_pty.so` and `librust_pty_arm64.so`. linux-x64 was not run. These are glibc builds, so Alpine is a separate question (reasoned).
5. Without OpenCode the server does not start (tried). `serve` exits 1 with "Unable to locate the opencode CLI on PATH". `OPENCODE_SKIP_START=true` plus `OPENCODE_HOST` does not help, the check runs first. With `opencode-ai` in the same prefix, `/health` reports `isOpenCodeReady: true`.
6. Writable needs are HOME and `/tmp`, nothing else (tried). No `EROFS` or `EACCES` in the logs with a read-only root and a read-only install dir. The server writes settings, `jwt-secret`, run state and logs under `~/.config/openchamber`.
7. OpenCode installs `@opencode-ai/plugin` into `~/.config/opencode/node_modules` at first start, 63 MB from npm (tried). With `--network none` the server and OpenCode still became ready and that folder was not created (tried). I did not check what an agent turn loses without it.
8. Auth used: `OPENCHAMBER_UI_PASSWORD` env, then `POST /auth/session` with `{"password":...}`, which sets cookie `oc_ui_session_3000`. This is the same call the SSH manager's probe makes. Without the cookie `/api/terminal/sessions` returns 401 (tried). The WebSocket upgrade also needs an `Origin` whose host equals the `Host` header. `/health` and `/api/system/info` are public.
9. A plain `sleep infinity` as PID 1 breaks `openchamber stop` (tried). The daemon exits but stays a zombie, so stop times out after reporting "Timed out stopping pid". `--init` plus `--foreground` as the container command fixed it.
10. The tools volume idea works as designed (tried). Filled by a root one-shot, mounted read-only into a non-root hardened container, server started from `/opt/oc-tools/bin`, terminal verified. `docker inspect` confirmed read-only root, `CapDrop [ALL]`, `no-new-privileges`, user 1000, no binds. Keep the npm cache out of the volume (`--cache /tmp/...`), it saves 122 MB. What would break: `openchamber update` cannot write into the install dir (reasoned).
11. Path B, tried in part. Worktree `server/` and `bin/` laid over the Linux-installed 1.24.2 fail at import: `'@openchamber/sdk' does not provide an export named 'SURFACE_AGENT_ACTIVE_HEADER'`. Same version number, different code. A dev delivery must carry the locally built sdk too.
12. Path B, reasoned. The worktree has no `node_modules` and no `dist`, so a full try meant `bun install` and three builds. I did not run it. What would be copied: tarballs from `bun pm pack` of `packages/sdk` (after `tsc -p tsconfig.build.json`) and `packages/web` (after `build-builtin-extensions.mjs`, which writes `server/built-in-extensions/`). `vite build` is only needed for the browser UI, and a space can run `--api-only`. Install both tarballs with npm inside the filler container so native packages resolve for Linux. Copying the macOS `node_modules` would half work: node-pty and bun-pty carry all platforms, but `sherpa-onnx-*` and `opencode-*` are per-platform optional packages and the Linux ones would be missing. Sherpa is loaded lazily for dictation only, OpenCode is not optional.

## What this changes in DESIGN.md

- "Versions": say that the filler needs the npm registry, and that a dev or unreleased host needs locally packed `web` and `sdk` tarballs copied into the filler. The registry cannot serve a version that was never published.
- "Versions": the base image must contain Node and be glibc-based. `node:22-bookworm` is 1.63 GB. `node:22-bookworm-slim` is the obvious next candidate. It has no `curl` or `git` (reasoned, not pulled).
- "Parts": add an init process and `serve --foreground` to the hardening list, with HOME on a volume and `/tmp` as tmpfs.
- Decide whether OpenCode's first-start plugin install goes through the gatekeeper or gets pre-seeded.
- Budget about 0.5 GB of memory per idle space.

## Not verified

- linux-x64, Alpine or musl, and any slim image.
- A full dev build delivered from this worktree.
- A real agent turn. No API keys were used, so OpenCode only reached "ready".
- The terminal over the published host port. The host had no `ws` module, so the WebSocket test ran inside the container. Plain HTTP from the host worked.
- `--pids-limit` lower than 512, and memory under load.
- Upgrading the tools volume while a space is running from it.
