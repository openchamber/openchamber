# Local Arch Package

This directory contains local Arch/CachyOS packaging for the Electron desktop build. It is intentionally named `openchamber-electron` so the package namespace stays explicit while the installed command remains `openchamber`.

## Prerequisites

Build the Electron Linux artifacts first from the repository root:

```sh
bun run electron:build
```

The package expects these local generated files to exist:

- `packages/electron/dist/linux-unpacked/openchamber`
- `packages/electron/dist/.icon-set/`
- `packages/electron/dist/latest-linux.yml`
- `packages/electron/dist/OpenChamber-1.11.2-x86_64.AppImage`
- `packages/electron/dist/OpenChamber-1.11.2-amd64.deb`

## Build Locally

From this directory:

```sh
makepkg --printsrcinfo > .SRCINFO
makepkg -f
```

The `PKGBUILD` does not fetch release artifacts. It copies the locally built `linux-unpacked` Electron output into `/opt/OpenChamber`, adds `/usr/bin/openchamber`, and installs desktop/icon metadata matching the Electron Builder deb output.
