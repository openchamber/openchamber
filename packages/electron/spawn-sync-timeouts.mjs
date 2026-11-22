// Named timeouts for the production spawnSync calls in early-startup.mjs
// and main.mjs (#833). spawnSync blocks the Electron main event loop for
// the child's whole life, so an unbounded call lets a hung helper (sw_vers,
// an editor CLI; where.exe and PowerShell run async in windows-app-discovery)
// freeze the whole desktop app indefinitely. Every production spawnSync in this package
// must carry a timeout — one of these, or an inline value as the reg.exe
// (early-startup.mjs) and xdg-mime (linux-app-discovery.mjs) sites
// already do. A timed-out child surfaces through each caller's existing
// failure shape (result.error set): fallback value, null, next spec
// candidate, or the filesystem scan — never a hang.
export const SW_VERS_SPAWN_TIMEOUT_MS = 5_000;
export const OPEN_IN_APP_SPAWN_TIMEOUT_MS = 10_000;
