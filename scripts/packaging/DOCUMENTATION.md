# Package-manager listings

Owns the winget manifests and the Homebrew cask of a stable release, and the `publish-package-managers` job in `.github/workflows/release.yml` that submits them. Other channels (AUR, Flathub, Snap Store, Windows Store) are not here yet.

## Ownership

- `render-package-manifests.mjs` renders both listings from the installers on the published GitHub release. It owns file names, checksums and manifest content. Product behavior stays in the app.
- The release job downloads the installers, renders, and submits. It owns credentials and the target repositories.
- Listing ownership after launch (answering winget-pkgs reviewers, tap maintenance) belongs to the maintainer.

## Invariants

- Only stable `x.y.z` versions are listed; Canary and pre-releases are refused.
- Checksums are computed from the files on the published release, never from the build workspace, so a listing never names a file users cannot download.
- The job runs after `finalize-release` and nothing depends on it. A failed submission leaves the release published; re-running the job retries.
- A channel without its credential is skipped, so the release works before the accounts exist.

## Setup the maintainer provides

| Name | Kind | Used for |
|---|---|---|
| `WINGET_PAT` | Secret | Token that can push to the winget-pkgs fork and open a pull request in `microsoft/winget-pkgs` |
| `WINGET_FORK` | Variable | The fork, for example `openchamber/winget-pkgs` |
| `HOMEBREW_TAP_TOKEN` | Secret | Token with push access to `openchamber/homebrew-tap` |

The first winget version is submitted by hand (`wingetcreate new` or this job's output) so the maintainer can answer the reviewers; later versions are opened by the job. `openchamber/homebrew-tap` must exist before the first release that has `HOMEBREW_TAP_TOKEN` set. The two channels are independent: a failing winget step does not stop the tap update. The job lists stable versions only and fails on a Canary or pre-release version, which `release.yml` does not build.

## Decisions

### Why our own renderer and not wingetcreate or a release action
The files that go to winget and the tap come from one renderer that tests cover, with no third-party action holding the tokens. `wingetcreate` would add a Windows runner and a download of its own.

### Why a tap and not homebrew/cask
`homebrew/cask` has popularity thresholds and its own bump bot. A tap updates in the same job as the release. Moving to the main cask later changes only the target.

### Why `auto_updates true` and `InstallerType: nullsoft`
The desktop app updates itself, so `brew upgrade` must leave it alone. The Windows installer is NSIS (electron-builder), which `nullsoft` describes with the silent switch `/S`.

### Why no `ProductCode` in the winget manifest
It has to match the registry uninstall key the NSIS installer writes, and that has not been checked on an installed build. Without it winget matches the installed app by name and publisher. Add it once verified on a Windows machine.
