# Secure Workspaces — handoff

State of the work on `feature/secure-workspaces-plugin` as of 2026-08-07, written for
whoever picks it up next. The authoritative requirements live in
`docs/SECURE_WORKSPACES_SPECIFICATION.md`; the working rules live in
`.agents/skills/secure-workspaces/SKILL.md` and **must** be read before editing, along
with the other skills `AGENTS.md` routes to.

`main` moves fast — around fifty commits every two days — so expect the PR to go DIRTY
repeatedly. Merge rather than rebase, and resolve conflicted hunks **by hand**: on this
branch `git checkout --theirs` twice discarded work that had merged cleanly, most
recently the whole Secure Workspaces settings page, which left the page in the navigation
rendering nothing.

---

## The test profile

Everything below runs against a disposable profile so the operator's real OpenChamber is
never involved. Two separate things point at it, and both are needed:

- `OPENCHAMBER_DATA_DIR` — where OpenChamber keeps settings, the OpenCode data root, the
  workspace journals, and credential stores.
- `--user-data-dir` — where Electron/Chromium keeps its own profile, including the logs.

```powershell
$profile = Join-Path $env:TEMP 'openchamber-functional-profile'
$env:OPENCHAMBER_DATA_DIR = $profile
Start-Process 'C:\…\packages\electron\dist\win-unpacked\OpenChamber.exe' `
  -ArgumentList "--user-data-dir=`"$profile\chromium`""
```

What lives where, once it has run:

| Path | Holds |
| --- | --- |
| `%TEMP%\openchamber-functional-profile\settings.json` | Every `secureWorkspaces*` setting, `projects`, `activeProjectId`, `lastDirectory`, and `desktopLocalPort` / `desktopLocalClientToken` |
| `…\chromium\logs\main.log` | The Electron main log — the first place to look |
| `…\opencode-data\opencode\log\` | The managed OpenCode's own log, which reports the directories it bootstraps |
| `…\workspace-sessions\` | The ordinary-session-start journal |
| `%TEMP%\openchamber-functional-project` | The project used for testing, with files earlier applies produced |

**Never hand-edit `settings.json` while the app is running.** Doing that once wrote a BOM
and the app silently reset every workspace setting and wiped the projects list. Drive the
app, or query it.

### Querying the running app

Everything the UI can do is reachable over the loopback API. The port and token are in
`settings.json`, and the header is `authorization: Bearer …` — **not**
`x-openchamber-client-token`, which returns 401.

```powershell
$s = Get-Content (Join-Path $env:TEMP 'openchamber-functional-profile\settings.json') -Raw | ConvertFrom-Json
$hdr = @{ authorization = "Bearer $($s.desktopLocalClientToken)" }
$base = "http://127.0.0.1:$($s.desktopLocalPort)"
Invoke-RestMethod -Uri "$base/api/workspaces/readiness" -Headers $hdr
```

`/api/workspaces/readiness` is the most useful single call: it reports whether the plugin
is registered, which providers are available, and the ordered setup steps with their
status. `/api/session` and `/api/experimental/workspace` go through to OpenCode.

### Clusters

Two kind clusters exist for isolation testing, and the difference between them is the
point:

- `kind-openchamber-np` — kindnet, **enforces** NetworkPolicy. Both published images are
  pre-pulled into its node.
- `kind-openchamber-open` — flannel plus manually installed CNI plugins, **does not
  enforce**.

A cluster accepting a NetworkPolicy is not a cluster enforcing one, which is why the
enforcement probe exists and why it must be exercised against both.

### Building

`bun run electron:build`, roughly twelve minutes. Two traps:

- Close the running app first. Packaging fails on a locked `d3dcompiler_47.dll`, and the
  message does not say so.
- Run it detached from a `.ps1` file with the script path **quoted** in
  `Start-Process -ArgumentList`. A space in the path silently kills it, and plain
  background builds get reaped mid-run.

### Running tests

There is no root test script. `packages/web` uses vitest (`npx vitest run`), `packages/ui`
uses `bun test`; `bun run test` fails because bun resolves `test` to Git's `test.exe`, and
`bunx` is absent from the Git Bash PATH.

Fourteen `packages/web` files fail on Windows on `origin/main` as well — compare against a
worktree of `origin/main` before treating a failure as this branch's.

The `packages/ui/src/sync` failures are **diagnosed, partly fixed, and worth finishing**.
They are not flakiness. Two distinct causes were found:

- `session-worktree-contract.test.js` imported `isWithinWorktreeRoot`, which the module
  defined but did not export. The file could not load at all, so **forty-five tests had
  never run once**. Exporting it fixed that, and they pass. Worth checking whether other
  files are silently in the same state — a test file that fails to load reports one error,
  which looks much like one failing assertion.
- `bun test` applies `mock.module` **globally to the process and never restores it**. A
  replacement listing only the few functions one file cares about becomes the module every
  later file sees, so they fail importing exports nobody touched, and the reported error
  names a symbol unrelated to the test that failed. This is why the suite passes one file
  at a time and fails run together. `session-actions.test.ts` holds seven such mocks; the
  `./sync-refs` one now spreads the real module first, which is the shape of the fix.

The same treatment does **not** work for its `./session-ui-store` and
`@/stores/useGlobalSessionsStore` mocks: importing those for real inside the mock factory
creates a cycle and the file stops loading. That was tried and reverted. Finishing this
means either breaking those cycles or running each test file in its own process.

---

## Where the feature stands

The plugin is pinned by immutable commit SHA in `packages/web/package.json`,
`packages/electron/package.json`, and the specification. Repin after every plugin merge,
then `bun install`. Current pin: `5dc9ef84` (PR #12, seed-pod cleanup fix).

The images are published from a `v*` tag only — nothing reaches operators from a merge to
`main`. `v0.1.1` was cut on 2026-08-07 and is the first release carrying OpenCode 1.18.12;
before it every workspace ran 1.18.4 while the host ran 1.18.12, because the Dockerfile had
moved forward and no tag had. After any future release, repin both digests in
`packages/web/server/lib/workspaces/policy.js`, the assertions in `routes.test.js`, and the
specification, and confirm the version by running the published digest rather than trusting
the build.

Verified working: Docker and Kubernetes providers on Windows, NetworkPolicy enforcement
observed in both directions on real clusters, workspace creation, session start, and the
plugin's own suite (157 tests, green on Windows).

Never completed by a person: the full Kubernetes cycle through the UI — create, session,
message, review, apply, delete.

### Open work, in the order it matters

1. **Workspace sessions are now findable — via a server-owned route record.** OpenCode
   exposes no session→workspace link in any read API (measured on 1.18.12:
   directory-scoped session lists exclude routed sessions, `?workspace=` is ignored,
   the single-session GET omits `workspaceID`), so OpenChamber records the
   session↔workspace↔project route itself at both creation paths: the intercepted
   `POST /api/session` (client/panel path) and the ordinary `sessions/start` route.
   `GET /api/workspaces/session-routes` serves it; sidebar ownership hydrates from it
   and from creation-time client memory. Sessions created before this record existed
   remain unattributable — recreate them or accept them unlisted. Upstream, serializing
   the persisted `workspaceID` on session reads is still the real fix and OpenCode's
   session table already stores it (`sessionWarp` reads `SessionTable.workspace_id`);
   contribute it.
2. **Phantom workspace sessions deserve a marker, not a hiding place.** A session with
   `directory=/workspace` and no recorded route is a transcript whose workspace no
   longer exists — it now passes the sidebar filter (the old invisibility was an
   accident of the raw-path bug) and renders with nothing to scope Files/Terminal to.
   The designed treatment: a muted "workspace no longer exists" badge in the sidebar,
   session opens read-only-ish, tabs stay on the active project. Predicate is exact
   (`/workspace` + no route); the work is the badge, a locale key in **all ten
   dictionaries** (the German key-parity lesson), and a test. Until then such leftovers
   can simply be deleted — sixteen were, on 2026-08-08.
3. **Windows credential stores** (`packages/web/server/lib/quota/credentials/store.js`,
   `remote-clients.json`) declare `0o700`/`0o600`, which Windows does not implement. The
   plugin's `src/windows-acl.js` is the working reference for the fix.
2. **The executable bit is lost** snapshotting a Windows project into a Linux container.
   Git's index has it (`git ls-files -s`) for a Git project.
3. **The SSE heartbeat proxy test** drives real timers with margins smaller than a loaded
   Windows machine's scheduling jitter.

### Things that cost hours before they were measured

- **`tar` flavour depends on PATH order.** Git for Windows ships GNU tar, which reads
  `C:\path` as `host:path`. The same shadowing hides `whoami`. Name System32 binaries by
  absolute path and never hand a Windows path to a tool whose flavour varies.
- **A Kubernetes create legitimately takes ~80 seconds.** Shorter waits report healthy
  workspaces as timed out.
- **A container path is not a path here.** `/workspace` is what a routed session reports,
  and OpenCode carries no `workspaceID` on session records — scoping a session query to a
  workspace returns the same list as not scoping it. So routed sessions arrive looking
  ordinary and only the path tells the truth. On Windows `/workspace` resolves against the
  current drive, and the host OpenCode was caught bootstrapping `C:\workspace` purely
  because such sessions sat in the list.
- **A protection asserted by a test that would pass without it is not asserted.** `%TEMP%`
  is already private on a normal profile, so permission tests must open their own
  directory to everyone first.
- **A prompt on every adjacent action is a security problem.** The step-up password was
  removed from everything except changing the policy; see section 23 of the specification
  for the reasoning, which is that nothing hostile can reach those endpoints anyway.
