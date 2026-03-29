# Arch Linux packaging skeleton for OpenChamber Desktop

This directory is a source-built Arch packaging starting point for the OpenChamber desktop app. It is intentionally limited to an **unofficial / experimental** `x86_64` `PKGBUILD` skeleton plus a matching `.desktop` template, and it is currently aimed at building the `gqcdm/openchamber` `i18n` branch rather than a tagged release tarball.

## What this skeleton reflects

- Package name defaults to `openchamber-desktop`
- Source strategy targets the `gqcdm/openchamber` `i18n` branch archive (`refs/heads/i18n`) instead of `refs/tags/v...`
- Build flow stays repo-native but intentionally bypasses Tauri AppImage/linuxdeploy bundling for Arch packaging
- The Arch packaging build step uses:
  - `packages/desktop/scripts/build-sidecar.mjs`
  - `cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml --release`
- Sidecar build produces a platform-specific `openchamber-server-<target-triple>` binary and copies `packages/web/dist` into Tauri resources
- Arch packaging installs these direct artifacts into `/usr/lib/openchamber-desktop`:
  - `packages/desktop/src-tauri/target/release/openchamber-desktop`
  - `packages/desktop/src-tauri/sidecars/openchamber-server-x86_64-unknown-linux-gnu`
  - `packages/desktop/src-tauri/resources/web-dist`
- Arch packaging also installs the checked-in desktop icon from `packages/desktop/src-tauri/icons/icon.png` into a standard Linux icon path
- Tauri config still defines bundled resources for upstream app packaging:
  - `sidecars/openchamber-server`
  - `resources/web-dist/**/*`

## Important assumptions

- Linux desktop support is **not official upstream support** today; upstream docs and release messaging are still macOS-first
- This packaging target is intentionally branch-oriented for the current `gqcdm/openchamber` `i18n` work rather than release-oriented version packaging
- The OpenChamber desktop app still has an external runtime prerequisite: **`opencode` must be installed separately**
- The package should surface that runtime requirement again at install/upgrade time via `openchamber-desktop.install`
- For Arch-managed installs, **pacman owns package updates**; the app's Tauri updater configuration should not be treated as the authoritative update path
- Arch packaging intentionally avoids the AppImage/linuxdeploy bundle path and installs direct build outputs instead
- The package build now makes a best-effort Rust `--remap-path-prefix` attempt to reduce `$srcdir` path leakage in the compiled desktop binary
- Dependency lists are best-effort placeholders derived from the repo's Tauri/Bun/Rust build context and likely need tightening after a real Arch build

## What still needs verification later

1. Confirm the direct runtime layout works cleanly with the desktop binary loading its sidecar and `web-dist` from `/usr/lib/openchamber-desktop`
2. Check whether the Rust path-remap attempt fully removes makepkg `$srcdir` references or if further hardening is needed
3. Refine `depends`, `makedepends`, and any required system libraries after an actual build in a clean Arch environment
4. Confirm whether any wrapper/env setup is needed for production Arch installs

## Why the `PKGBUILD` is still useful now

It gives the orchestrator a repo-native packaging base that already captures the correct desktop build sequence, targets the `gqcdm/openchamber` `i18n` branch source model explicitly, names the Linux target triple (`x86_64-unknown-linux-gnu`), and keeps the unsupported / experimental Linux status visible instead of implying that this is a finished official package.

## Arch install/update policy

- `PKGBUILD` keeps `opencode` as an explicit runtime dependency, but the package also includes a pacman `.install` script so users see the prerequisite during install and upgrade
- Arch users should update this package through pacman/package rebuilds, not through the app's bundled updater metadata

## Linuxdeploy/AppImage bypass

- This Arch packaging does **not** depend on Tauri successfully running linuxdeploy or producing an AppDir/AppImage bundle
- Instead, it installs the direct Linux build outputs that already exist before the bundling step fails
