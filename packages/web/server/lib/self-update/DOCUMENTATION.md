# Self-update

## Ownership

This module owns OpenChamber's own update routes: the update check, release notes, installation and restart, and the models metadata and Zen model list routes registered beside them. Package-manager detection lives in `../package-manager.js`; the release notes source lives in `../changelog`.

## Invariants

- Restarted OpenChamber servers receive the existing UI password through the update child's environment because flags appear in process lists and logs. Batch log text escapes command syntax and percent expansion, and restart commands double literal percent characters so cmd preserves them.

## Modules

- `packages/web/server/lib/self-update/openchamber-routes.ts`: OpenChamber update and models metadata route registration.

## Public exports (openchamber-routes.ts)
Browser completion checks use `appType=web&updateStatus=true` to stay on the
Desktop Host's native updater. A rejected native restart is retained in the
server process and returned to these polls as `DESKTOP_UPDATE_RESTART_FAILED`;
ordinary availability checks remain usable so a browser reload can offer a
retry. Starting another installation clears the previous restart error.
The shared UI's `lib/web-update.ts` parses install/check responses and waits
for the installed native target version, rather than treating absence of a
newer release as installation success. Poll requests have individual deadlines
within a ten-minute overall deadline.

- `registerOpenChamberRoutes(app, dependencies)`: registers OpenChamber endpoints:
  - `GET /api/openchamber/update-check`
    - A server installed from npm follows the update channel picked in
      Settings → About (`serverUpdateChannel` in `settings.json`; without a
      pick, Canary for a Canary build and Stable otherwise). On Canary the
      target is the `canary` npm dist-tag, published nightly by
      `.github/workflows/canary.yml`; Stable from a Canary build offers the
      `latest` dist-tag even though it is older, which is the way back. Both
      read npm, since the website API serves only the release; it still gets
      the check-in. The install route and `openchamber update` read the same
      channel through `checkForUpdates`. The desktop app keeps its own
      `desktopUpdateChannel`. The Android app ships only as Canary until it
      has a store release: every Android build, an APK from an earlier release
      included, is offered the newest APK of the `canary` GitHub pre-release, downloaded from the R2 mirror (`downloads.openchamber.dev/desktop/canary/`) once canary.yml put it there. Other app types stay on releases.
  - `GET /api/openchamber/release-notes?version=&since=`
    - Settings → About shows these. The answer is the releases of `version` as data, `{ releases: [{ version, date, title, intro, groups: [{ key, bullets }] }] }`,
      read from the website API's `/v1/changelog/full`, which keeps the last
      good copy through a GitHub outage, else from `changelog/index.json` on
      `main`; a Canary version reads the Canary nights
      (`lib/changelog/update-notes.js`). With an older `since`
      it lists what an update brings, `(since, version]`; otherwise `version`
      alone. An empty list means the changelog has no notes for it; 502 means
      no source could be read, so the page never shows an outage as "no notes".
  - `POST /api/openchamber/update-install`
    - A release that needs a newer OpenCode than this server runs answers 409
      `OPENCODE_TOO_OLD` before any command runs, and the update check marks
      it `installBlocked: 'opencode-version'` with `requiredOpenCodeVersion`
      and `openCodeVersion`, ahead of the other blocks; clients keep the Update
      button disabled with the reason under it. The new build would refuse to
      start against that OpenCode, and an external one cannot be updated from
      the app. The requirement is `engines.opencode` (`>=2.2.4`) in the
      release's published `package.json`, which repeats
      `MINIMUM_OPENCODE_VERSION` (a test keeps the two equal). A release
      without the field, a registry that cannot be read, or an OpenCode
      version that cannot be read blocks nothing. Desktop-managed hosts update
      through `electron-updater`, whose feed carries no requirement.
    - A copy no package manager installed answers 409 before any command
      runs: a global install would add a second copy and leave the running
      one as it is. Detection reports such a copy as `unmanaged-install` when
      no package manager claims it and its path is outside any `node_modules`
      folder: an unpacked tarball, the Docker image, a source checkout. A copy
      inside `node_modules` that no check attributes keeps `default-fallback`
      and the npm install, since a version manager's npm may still own it.
      The update check marks an
      unmanaged copy's update `installBlocked: 'manual-install'`, and a
      foreground server without a service manager `installBlocked:
      'service-manager'`, so clients show manual steps in place of an Update
      button.
    - Desktop-managed hosts delegate authenticated Web update requests to the Electron main process, which checks, downloads, and applies the update through `electron-updater` before restarting the host. A host installed from a Linux `.deb` or `.rpm` asks for the administrator password on its own screen, so its check reports `installBlocked: 'desktop-host'` and the install route answers 409 `DESKTOP_UPDATE_LOCAL_ONLY` before anything stops; clients say to update on that computer.
    - Foreground servers running under a systemd user unit queue installation in
      a separate transient unit and restart the configured service afterwards.
      `OPENCHAMBER_SYSTEMD_UNIT` overrides the default `openchamber.service`.
    - Foreground servers running under a macOS launchd User LaunchAgent update the
      package and trigger a `launchctl kickstart` (with a `launchctl bootstrap`
      fallback, as `openchamber startup enable` uses) against
      `~/Library/LaunchAgents/dev.openchamber.web.plist`. The server counts as the
      LaunchAgent only when the plist exists and launchd set `XPC_SERVICE_NAME` to
      its label, so a manual `serve --foreground` keeps the 409.
    - On Windows the install-and-restart script is written to
      `<data dir>/update-install.cmd` before the response and run with
      `cmd.exe /c <file>`. A newline ends a `cmd.exe /c` command line, so the
      same script passed as an argument ran nothing and exited 0; the batch
      file keeps every line. The package-manager line is `call`ed because
      npm, pnpm and yarn are `.cmd` shims that would otherwise end the script,
      the pre-install pause is a loopback `ping` because `timeout` rejects a
      detached child's stdin, and the file deletes itself on its last line
      because the restart command carries the server's flags. If the file
      cannot be written the route answers 500 and the server keeps running.
      The listener is closed before the batch is spawned: on Windows the
      detached child inherits the listening socket and would hold the port
      for the whole batch, so the restart inside it failed with "port already
      in use" and the update ended with no server.
  - `GET /api/openchamber/models-metadata`
  - `GET /api/zen/models`

### Why launch options retain decoded JSON types

The instance file has no schema validation. Its fields retain JSON types until
an operation needs a string. Non-null primitive documents still behave like
missing fields; a null document and a truthy non-string host retain the original
property-access errors. The host guard preserves the error before either shell
command is built.

The UI password passes unchanged through `withUserEnv`. Node converts environment
values when spawning the update child. The local `child-process.d.ts` overload
describes that existing acceptance for ignored or numeric output descriptors;
it leaves pipe-returning overloads unchanged. The shared environment helper's
generic value type describes its existing spread without claiming validation.

### Why desktop updater methods need no repeated callable checks

Server composition admits the desktop updater only after checking all 3 methods.
The route dependency uses that contract and retains the absent-updater response.
Request query, header and environment strings still use primitive-string checks.
Thrown values retain optional `name` access without requiring an `Error` instance,
so plain objects and primitive throws keep their status-code behavior.

### Why the OpenCode requirement rides in `package.json` and not in the update check's answer

The running build cannot know what a later release needs, so the release has to
say it. The npm server installs that release from the registry, so
`engines.opencode` in the published `package.json` reaches the check through
`bun publish`, with no change to the website API, the R2 mirror or the release
workflows. npm (even with `engine-strict`) and bun install a package whose
`engines` names OpenCode.
