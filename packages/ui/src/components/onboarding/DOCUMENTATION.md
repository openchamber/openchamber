# Onboarding

## Ownership

This module owns the first-launch host choice, local CLI setup, desktop
connection recovery, and the remote connection form shared by onboarding and
recovery. Host persistence, probing, pairing import and server update belong to
`lib/desktopHosts`; the enterprise binary pin belongs to
`stores/useEnterprisePolicyStore`; the desktop shell owns the boot outcome and
the restart call.

## Invariants

- An enterprise-pinned OpenCode binary wins over the user's saved path in both
  the chooser and local setup. The field shows the pinned value and stays
  disabled, and Browse and Apply disappear, because the server ignores the saved
  path while the administrator pins one.
- Applying a binary path restarts the desktop app so the native host
  re-evaluates the boot outcome with the new path. Outside the desktop shell the
  screen posts `/api/config/reload` instead.
- Recording the first choice sets `initialHostChoiceCompleted`. Selecting local
  also sets `defaultHostId: 'local'`; choosing remote leaves the stored default
  alone, or null, until a connection succeeds.
- Recovery offers a server update only for `remote-incompatible` when the boot
  named a saved host that is still in the hosts file and resolves to a direct
  address. A server reached through an environment override has no hosts entry,
  so it gets no update action.
- A server update ends in a state the screen can show: `auth`, `refused` with the
  server error, `timeout`, or a restart. A restart that fails returns the state to
  idle, where Retry stays available and restarts the app as well.
- The remote form opens only on an explicit user action from recovery.
  `remote-wrong-service` does not prefill the URL or label it already knows to be
  wrong.
- `resolveRecoveryNextStep` decides what "use local" does: `local-unavailable`
  enters local setup without reloading or persisting a choice, every other
  variant switches the stored default to local and then restarts or reloads.
- A successful probe renders its own success panel with latency. The probe
  message table covers only advisory and failure statuses, so `ok` returns null
  there.

## Decisions

### Why the waiting dot is its own component

`WatchingDot` re-renders once a second through `useWaitingBlink`. Keeping it
separate leaves the chooser and its inputs out of that render.

### Why a derived mode and not a local-setup branch inside recovery

Recovery mode returns early. Entering local setup from recovery sets a flag that
the derived `effectiveMode` reads, so the screen falls through to the same
local-setup branch as the rest of the app. Duplicating that branch behind the
recovery return would leave the two paths to drift apart.

### Why the recovery subflow resets on prop changes

The local-setup and remote-form views belong to one recovery target.
`OnboardingScreen` clears both when mode, variant, host URL or host label
changes, so a subflow left open for one target cannot stay on screen for
another.
