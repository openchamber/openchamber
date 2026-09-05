# Guest panels

## Purpose

OpenChamber-owned install and static serve for iframe guests. This is not the OpenCode plugin manager (`plugin-routes.js` / Settings → Plugins).

## Routes

- `GET /api/guests` — installed guests. `attach: true` is on the row when the manifest set it. `version` is the package.json semver when present. `integration` is the public slice only: name, description, `auth`, setting field defs. OAuth URLs and token origins stay on the server. `agent` is the public slice when the package declared one: `runtime`, optional `permissions` (socket ids + exec names), optional `socketBindings` (resolved paths for this host), and `granted`. `enabled` is false when the user paused the extension in Settings → Extensions. Failure is 500, not an empty list.
- `GET /api/guests/:id/oauth/status` — `{ connected, account, hasClient, settings, redirectUri }`. No secrets. Host Linear merges first-party Linear status. `redirectUri` is empty unless `auth` is `oauth`.
- `PUT /api/guests/:id/oauth/client` — client id and optional secret from the Integrations form. OAuth guests only.
- `PUT /api/guests/:id/token` — pasted API token. Token guests only. The host probes the declared account path. The token never goes to the iframe.
- `PUT /api/guests/:id/settings` — declared keys only.
- `POST /api/guests/:id/oauth/start` — PKCE S256 for OAuth guests. Host Linear starts the first-party Linear authorize URL. Token guests get `NO_INTEGRATION`.
- `GET /api/guests/:id/oauth/callback` — public HTML page. The provider redirects here with no UI bearer. State and verifier stay on the server. If the provider omits `state`, the one pending exchange for that guest is used. Host Linear uses the first-party Linear callback, not this URL.
- `DELETE /api/guests/:id/oauth` — drops tokens for that guest. Client and settings stay. Host Linear disconnects the first-party Linear workspace.
- `POST /api/guests/:id/request` — authenticated UI session. Attaches Authorization. Path must stay on that guest's `apiOrigin`. Token guests send the raw token. Host Linear sends the Linear bearer to `https://api.linear.app` only. Linear issue file URLs stay on `GET /api/linear/issues/get`. The guest proxy does not add Linear headers. A paused extension (`enabled: false`) is 400 `DISABLED`; tokens stay.
- `POST /api/guests/:id/agent/request` — authenticated UI session. Proxies to that guest's host-spawned agent on `127.0.0.1`. Spawns on first use after grant when `permissions` need it. Missing grant, missing agent, or bad path is 400 with `NO_AGENT` / `BAD_PATH`. Paused extension is 400 `DISABLED` (agent stopped). Ready failure is 502 `AGENT_FAILED`.
- `GET /api/guests/:id/agent/status` — `{ status }` for that guest's agent runtime (`stopped` / `starting` / `ready` / `failed`).
- `PUT /api/guests/:id/agent/grant` — records allow for the declared local agent. Public catalog then shows `agent.granted: true`.
- `PUT /api/guests/:id/agent/sockets` — `{ id, path }` for a declared socket binding. Empty or null `path` clears the override. Stops a running agent for that guest. Catalog `agent.socketBindings` shows `resolved` and `override` for this host.
- `PUT /api/guests/:id/enabled` — `{ enabled }`. False is a full pause: catalog `enabled: false`, rail/attach/Integrations hide the guest, open panels close, cloud `request` and `agent/request` return `DISABLED`, and a running agent stops. Tokens and grants stay until Remove.
- `POST /api/guests` — `{ path }` or `{ url }`, exactly one. `path` is an absolute folder or a local `.zip`. `url` is https git or an https `.zip`. Folder persist is the realpath in this instance's `{openchamberDataDir}/extensions.json`, 201. Zip and git copy into `{openchamberDataDir}/guests/{id}`. Missing, invalid, or relative path is 400 `invalid-path`. A bad URL is 400 `invalid-url`. Clone fail is 400 `clone-failed`. Extract fail is 400 `extract-failed`. A panel whose HTML loads a relative `.js` that is not on disk is 400 `missing-build`. An agent whose entry file is missing is also 400 `missing-build`. Missing or non-semver `package.json` `version` is 400 `invalid-manifest`. A package whose `engines.openchamber` is newer than this host is 400 `host-too-old` (body may include `required`). Duplicate id or folder is 409. Two OpenChamber processes with different `OPENCHAMBER_DATA_DIR` do not share this list.
- `DELETE /api/guests/:id` — drops the store row, any agent grant, and socket overrides; stops a running agent. Path-install does not delete the user's folder. Zip and git copies under `{openchamberDataDir}/guests/` are deleted. Unknown id is 404.
- `GET /api/guests/:id/{*filePath}` — a file inside that guest's package root. Unknown id, escape, missing file, or unknown type is 404. Guest HTML gets the request's `oc_url_token` copied onto relative `script` / `link` / `img` URLs so the iframe can load its own files. On Bun (`oc-dev`), a sibling `panel/main.ts` is compiled to an IIFE when present. If that compile fails (missing deps, etc.), the host serves the on-disk `panel/main.js` instead of blanking the panel.

## Install

Guests do not ship inside the app. Add a folder, a local `.zip`, or an https git / zip URL from Settings → Extensions. Connect on Settings → Integrations. A guest must ship `panel/main.js` as a classic IIFE from `bun run --filter @openchamber/sdk bundle -- panel/main.ts panel/main.js`. `package.json` needs a semver `version` (`1.0.0`); Settings → Extensions shows it on the card. `panel.icon` is a Remixicon name or a package `.svg` path; a missing SVG fails install as `invalid-manifest`. Optional `engines.openchamber` (`1.22.0` or `>=1.22.0`) is checked at install against this OpenChamber version. Packaged Electron and `openchamber serve` run the server on Node and will not compile TypeScript. `oc-dev` on Bun still compiles `panel/main.ts` when it serves `panel/main.js`, including SDK files the panel imports. The iframe has no `allow-same-origin`, so ESM imports do not run.

Folder install stores the realpath with `source: "path"`. Zip and git extract or clone into `{openchamberDataDir}/guests/{id}` (`source: "zip"` / `"git"`). Zip limits: 20MB archive, store/deflate only, no zip64 or encryption, no `..` paths, 500 files / 40MB uncompressed. A single wrapper folder around `package.json` is unwrapped. Uninstall deletes zip/git copies and leaves path-install folders alone.

OAuth and pasted tokens live in `{openchamberDataDir}/guest-auth.json`. Host Linear tokens stay in `linear-auth.json`. Writes are atomic and `0o600`. The file is per OpenChamber instance, same as `extensions.json`. Web and desktop share it. VS Code and mobile set the guest catalog to `unsupported`. That is not an empty ready list. Those cards stay hidden.

A missing folder is omitted from the list. Other guests stay. A corrupt `extensions.json` is 500, not an empty catalog. A missing or blank `guest-auth.json` is an empty store. Corrupt JSON there is 500, not a disconnected card. This is not Settings → Plugins.

## Invariants

- Paths stay inside the package root (`realpath`). `..`, absolute paths, and URLs do not serve.
- Only an allowlisted content type is served.
- Host and guest speak `@openchamber/sdk`. Do not copy those types into `packages/ui`.
- `contributes.attach` is copied as `"panel"` or `"dialog"`. The composer + menu and New Worktree read that field. Omitted guests stay off those menus.
- `request` never leaves the declared `apiOrigin`. A 401 refreshes once. If that fails, tokens for that guest are dropped. Host Linear does not drop Linear auth on a failed GraphQL query. A paused guest never proxies `request` or `agentRequest`.
- `agentRequest` never leaves that guest's loopback port. Auth to the agent is `Authorization: Bearer` with a host-minted token. Ready is `GET /health` → 200. Parallel first requests share one spawn; they must not kill each other mid-start. Host quit stops every agent. Disabling a guest stops its agent without clearing OAuth or grants.
- The OAuth callback skips UI auth. Everything else under `/api/guests` stays behind the usual session.
