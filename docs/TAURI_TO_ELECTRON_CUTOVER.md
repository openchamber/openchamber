# Tauri → Electron auto-update cutover

> Self-contained playbook. The branch and conversation where this plan was
> designed will not be around when the cutover happens — read this file top to
> bottom and execute; do not assume prior context.

## What this is

OpenChamber historically shipped as a Tauri app. A parallel Electron shell was
added on branch `electron-app` (merged to `main` as part of a larger migration).
Since then, both desktop shells have been released in the same GitHub release
and each has its own auto-update channel:

| Shell    | Manifest          | Update format       | Secret used to sign |
|----------|-------------------|---------------------|---------------------|
| Tauri    | `latest.json`     | `.tar.gz` + `.sig`  | `TAURI_SIGNING_PRIVATE_KEY` (minisign) |
| Electron | `latest-mac.yml`  | `.zip` + `blockmap` | Developer ID codesign (APPLE_* secrets) |

Existing Tauri installs keep their own auto-update path (`latest.json`).
Electron installs auto-update through `latest-mac.yml`. They coexist without
conflict because filenames and manifests differ.

At some point the user wants to **stop maintaining the Tauri build** and make
the Tauri installs migrate themselves into Electron via auto-update. This
document describes how to do that in a single "transition release".

## The core trick

Tauri's updater downloads whatever `.tar.gz` the `latest.json` points at,
verifies the minisign signature, unpacks the contents **over** the existing
`.app` directory, and restarts. It does **not** introspect the payload — it
just replaces files.

So: produce a `.tar.gz` of the Electron `.app`, sign it with the existing
Tauri minisign key, point `latest.json` at it. Tauri users receive the update,
their `OpenChamber.app` becomes the Electron bundle in-place, and next launch
starts Electron. Subsequent updates go through `latest-mac.yml`
(electron-updater). One-way migration, one-shot workflow change.

## Prerequisites before running the cutover

Check all of these before making any release:

1. **Electron has shipped stable through its own `latest-mac.yml` path for at
   least 2 releases.** Verify:
   ```
   gh release list --repo btriapitsyn/openchamber
   gh release view vX.Y.Z --repo btriapitsyn/openchamber \
     | grep -E 'OpenChamber-.*\.zip|latest-mac\.yml'
   ```
   A user on Electron should have successfully auto-updated at least once.
   If not, pause and stabilise that path first — don't stack risk.

2. **`~/.config/openchamber/settings.json` is still the shared state path.**
   Tauri `src-tauri/src/main.rs:settings_file_path` and Electron
   `packages/electron/main.mjs:settingsFilePath` must both resolve to
   `$HOME/.config/openchamber/settings.json`. If either has moved, data parity
   breaks and this migration loses user data. Audit both paths, update the
   non-migrated shell to match before proceeding.

3. **Electron `appId` is `dev.openchamber.desktop`** (check
   `packages/electron/package.json` `build.appId`). Tauri identifier is
   `ai.opencode.openchamber`. These differ intentionally — it means macOS
   LaunchServices will re-register after the in-place replace. That's fine but
   see "Risks" below.

4. **All GitHub secrets still valid:** `APPLE_CERTIFICATE`,
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
   `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. A
   workflow_dispatch dry-run should succeed before the real tag.

5. **`minisign` CLI is available on the macOS runner** (or installable via
   brew). Used to sign the Electron tarball with the Tauri key.

## Release workflow changes

The file to edit: `.github/workflows/release.yml`.

Today it has these jobs (simplified):

```
create-release
├── build-desktop-macos           (Tauri  .dmg/.tar.gz/.tar.gz.sig)
├── build-desktop-electron-macos  (Electron .dmg/.zip/blockmap/latest-mac.yml)
├── publish-npm
├── combine-manifests             (merges Tauri per-arch JSONs → latest.json)
├── combine-electron-manifests    (merges Electron per-arch YMLs → latest-mac.yml)
└── finalize-release
```

### Step 1 — Remove the Tauri build

Delete these jobs entirely:
- `build-desktop-macos`
- `combine-manifests`

They are replaced by the repackage job (below). `finalize-release` `needs:`
list must be updated to drop both.

### Step 2 — Add a repackage job

Insert after `build-desktop-electron-macos`:

```yaml
repackage-electron-as-tauri-update:
  needs: [create-release, build-desktop-electron-macos]
  runs-on: macos-26
  strategy:
    fail-fast: false
    matrix:
      include:
        - arch: arm64
          platform: darwin-aarch64
        - arch: x64
          platform: darwin-x86_64
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - uses: actions/setup-node@v4
      with:
        node-version: '20'

    # Pull the signed+notarized Electron .app that build-desktop-electron-macos
    # already produced. Either re-download the dmg and mount+copy the .app, or
    # (cleaner) modify build-desktop-electron-macos to upload the .app itself
    # as an artifact so this job can download it. Prefer the latter — adds one
    # `actions/upload-artifact@v4` step uploading `packages/electron/dist/mac-<arch>/OpenChamber.app`.

    - name: Download signed Electron .app
      uses: actions/download-artifact@v4
      with:
        name: electron-app-${{ matrix.arch }}
        path: staged

    - name: Install minisign
      run: brew install minisign

    - name: Tar and sign Electron .app as Tauri update payload
      env:
        TAURI_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
        TAURI_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        VERSION: ${{ needs.create-release.outputs.version }}
      run: |
        set -euo pipefail
        cd staged
        # The tarball name convention Tauri's updater expects. Must end in
        # `.app.tar.gz`. Name stays stable — Tauri updater does not care about
        # the inner .app name.
        TARBALL="OpenChamber.app.tar.gz"
        tar -czf "$TARBALL" OpenChamber.app

        # minisign needs the private key written to a file and a non-interactive
        # password via -W (or env). The key in the secret is a minisign secret
        # key block (base64-ish multi-line blob). Write to a file verbatim.
        echo "$TAURI_KEY" > ../tauri-signing.key
        echo "$TAURI_KEY_PASSWORD" | minisign -S -s ../tauri-signing.key \
          -m "$TARBALL" -W

        # Rename per platform so the release has distinct names for arm64/x64.
        mv "$TARBALL" "OpenChamber-${VERSION}-${{ matrix.platform }}.app.tar.gz"
        mv "${TARBALL}.minisig" "OpenChamber-${VERSION}-${{ matrix.platform }}.app.tar.gz.sig"

    - name: Generate Tauri latest-<platform>.json
      env:
        VERSION: ${{ needs.create-release.outputs.version }}
        REPO: ${{ github.repository }}
      run: |
        SIG=$(cat staged/OpenChamber-${VERSION}-${{ matrix.platform }}.app.tar.gz.sig)
        TAR=OpenChamber-${VERSION}-${{ matrix.platform }}.app.tar.gz
        cat > staged/latest-${{ matrix.platform }}.json <<EOF
        {
          "version": "${VERSION}",
          "notes": "OpenChamber has moved to Electron. This update replaces the Tauri shell with the Electron build. Subsequent updates will be delivered via the Electron auto-updater.",
          "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
          "platforms": {
            "${{ matrix.platform }}": {
              "signature": "${SIG}",
              "url": "https://github.com/${REPO}/releases/download/v${VERSION}/${TAR}"
            }
          }
        }
        EOF

    - name: Upload tarball + sig to release
      uses: softprops/action-gh-release@v2
      with:
        tag_name: v${{ needs.create-release.outputs.version }}
        files: |
          staged/*.app.tar.gz
          staged/*.app.tar.gz.sig
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

    - name: Upload per-platform manifest as artifact for merge
      uses: actions/upload-artifact@v4
      with:
        name: tauri-manifest-${{ matrix.platform }}
        path: staged/latest-${{ matrix.platform }}.json
        retention-days: 1
```

### Step 3 — Re-add the `combine-manifests` job

Bring it back (it was deleted in Step 1) but sourcing artifacts from the
repackage job instead of the old Tauri build. The merging logic is identical
to what the old job did. Minimum job shape:

```yaml
combine-manifests:
  needs: [create-release, repackage-electron-as-tauri-update]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/download-artifact@v4
      with:
        pattern: tauri-manifest-*
        path: artifacts
    - name: Merge
      run: |
        # Copy the original merge logic from git history. It takes the two
        # per-platform JSONs and produces a single `latest.json` with both
        # platform entries. Upload as a release asset.
        # Search git history: git log --all --diff-filter=D -- .github/workflows/release.yml
        # Find the commit that deleted the old merge step and copy its shell block.
        ...
    - uses: softprops/action-gh-release@v2
      with:
        tag_name: v${{ needs.create-release.outputs.version }}
        files: artifacts/latest.json
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Step 4 — Update `finalize-release.needs`

```yaml
finalize-release:
  needs: [create-release, build-desktop-electron-macos, repackage-electron-as-tauri-update, publish-npm, combine-manifests, combine-electron-manifests]
```

### Step 5 — Remove Tauri-specific code

After the transition release ships and has been out at least 2 weeks with no
rollback, remove:

- `packages/desktop/` (entire package — Tauri Rust + UI glue)
- Any `isTauriShell()` branches that are now dead code in
  `packages/ui/src/` (search for the symbol; most call sites already fall
  through to the Electron path because our preload exposes a `__TAURI__` shim;
  audit each before removing).
- This file (`docs/TAURI_TO_ELECTRON_CUTOVER.md`) — mission accomplished.

Do this in a separate PR. Keep the transition release workflow intact until
the cleanup lands; rolling the cleanup into the transition release itself
makes debugging much harder if the migration misbehaves for a user.

## Validation before tagging the transition release

You must manually validate with a real Tauri install. Do NOT skip this.

1. Have the previous Tauri release installed locally
   (`/Applications/OpenChamber.app` with `Contents/Info.plist` showing
   `CFBundleIdentifier = ai.opencode.openchamber`).
2. Tag the transition release to a test tag
   (e.g. `v2.0.0-migration-test`) and push.
3. Let the workflow complete. Do not merge cleanup PR yet.
4. In the running Tauri app, use the built-in "Check for updates".
5. Accept the update. The app should download, verify, extract, restart.
6. After restart, `Info.plist` under `/Applications/OpenChamber.app/` should
   now show `CFBundleIdentifier = dev.openchamber.desktop`.
7. Settings should be intact: hosts list, default host, sessions history.
8. In the new Electron app, "Check for updates" should report no update
   available (it's now at the transition version, which is the latest).
9. Produce a dummy v2.0.1 Electron-only release to prove the subsequent
   Electron-path update works. Accept it. App relaunches into v2.0.1.

If any step fails:
- Delete the test tag and GitHub release.
- Do not delete yet-shipped artifacts from a real tag until rollback below.

## Rollback if the transition release misbehaves

If users report the Tauri → Electron update bricks their install:

1. **Immediately** delete the latest release asset
   `OpenChamber-*.app.tar.gz` and `latest.json` from the GitHub release
   (keep the DMGs so manual download still works).
2. Re-upload the previous version's `latest.json` as the current latest so
   Tauri updaters see "up to date" instead of a broken update on next check.
3. Post a support note: users who already applied the broken update can
   download a fresh Electron `.dmg` manually and drag-replace. Their
   `~/.config/openchamber/settings.json` survives.
4. Investigate, fix the workflow, retry with a new version number.

## Risks & edge cases

### Different `CFBundleIdentifier` at same path
macOS LaunchServices caches identifier ↔ path mappings. When we replace
`ai.opencode.openchamber` with `dev.openchamber.desktop` at the same `.app`
path, LaunchServices will rebuild on next launch (automatic). Usually fine.
If a user's system is in a weird state, a `killall Dock` or logout/login
fixes it. Worth noting in the release notes.

### macOS notification permissions
Notification permission is per-bundle-id. After migration, the app has a new
bundle-id, so the first notification will re-prompt the user. Unavoidable.
Mention in release notes.

### Deep-link protocol registration
The `openchamber://` protocol was registered for `ai.opencode.openchamber`.
After migration, `dev.openchamber.desktop` registers itself on first launch.
LaunchServices updates the handler. Usually seamless. Test with
`open 'openchamber://session/test'` post-migration.

### Gatekeeper "damaged app" dialog
Rare. Triggered if the replaced `.app` fails a mid-extract codesign check.
Can happen if Tauri's extractor corrupts xattrs. Mitigation: test on a
pristine macOS install before tagging production.

### Users on unsupported old Tauri versions
If a user is on a very old Tauri build that doesn't know how to do the
fetch-verify-extract flow, they're stuck. Expected: negligibly few users;
they'll just stay on their old version forever until they manually download.
Acceptable.

### Rollback-after-migration-accepted is impossible per-user
Once a user is on Electron, the Tauri updater is gone. If they want to go
back to a Tauri build, they must manually download. We don't support this.

## Relevant files to understand before making changes

- `.github/workflows/release.yml` — the release workflow.
- `packages/electron/package.json` — electron-builder config (appId,
  mac/dmg, publish, artifactName).
- `packages/electron/main.mjs` — autoUpdater setup (`setupAutoUpdater`,
  `desktop_check_for_updates`, `desktop_download_and_install_update`,
  `desktop_restart`). Understand this flow before touching the CI.
- `packages/electron/scripts/finalize-latest-yml.mjs` — per-arch
  `latest-mac.yml` merger. Already wired in `combine-electron-manifests`.
- `packages/desktop/src-tauri/tauri.conf.json` — legacy Tauri identifier,
  minisign pubkey embedded for updater verification. Don't modify; just
  reference for context.

## Working protocol

Default to a dry-run (test tag like `vX.Y.Z-migration-test` on a workflow_dispatch
run) before the real tag. Surface only business-level decisions —
"cutover this release, or hold one more cycle?" — and make technical calls
(minisign invocation flags, YAML layout, job dependency order) yourself,
documenting each one in the PR description.
