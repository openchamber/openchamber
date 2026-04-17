# Windows Refactor Planning Documents

This directory contains the planning documents for the Windows compatibility refactor.

## Documents

- `openchamber-refactor-plan.md` - Master plan: phases, specs, risk register, DoD
- `openchamber-platform-adapters-spec.md` - Full implementation spec for the four platform adapter modules
- `openchamber-refactor-tracker.md` - Sprint checklist

## Branch Strategy

Each phase has its own independently-mergeable branch:

- `refactor/phase-0-foundations` <- current
- `refactor/phase-1-path-canonicalization`
- `refactor/phase-2-spawn-utils`
- `refactor/phase-3-terminal-parity`
- `refactor/phase-4-git-longpaths`
- `refactor/phase-5-watching-eol`
- `refactor/phase-6-tauri-windows`

## Key Rule

All `process.platform` checks must live in `packages/web/server/lib/platform.ts`.
No other file may check `process.platform` directly.
