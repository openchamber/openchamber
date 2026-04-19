# Platform Abstractions

This document defines how OpenChamber should handle platform-specific behavior going forward.

## Motivations

The Windows refactor exists because platform behavior was previously spread across unrelated modules.

Problems this caused:
- The same path could be stored in multiple shapes such as `C:\\repo`, `C:/repo`, and `/c/repo`.
- Raw `process.platform` checks were scattered across the codebase with no shared contract.
- Callers often mixed persistence paths, display paths, and native filesystem paths.
- Equality checks depended on string formatting instead of path identity.
- Windows-specific regressions were hard to detect because there was no single abstraction boundary to audit.

The practical effect was inconsistent behavior in project lookup, worktree detection, session mapping, and filesystem access.

## Best Practices

Platform abstractions are better when they separate intent from platform details.

Preferred conventions:
- Use shared adapters such as `packages/web/server/lib/platform.*` and `packages/web/server/lib/PathUtils.*` instead of inline platform branching.
- Use `packages/web/server/lib/SpawnUtils.*` for child-process execution, managed startup retries, executable lookup, and platform-aware process termination instead of feature-local `spawn` or `spawnSync` flows.
- Use `SpawnUtils.spawnOnceSync()` for synchronous platform-sensitive detection/probe code that cannot reasonably become async at the current call boundary.
- Use `SpawnUtils.launchDetached()` for fire-and-forget OS integration commands such as reveal/open shell-outs.
- Store one canonical representation for persisted path keys.
- Convert to native OS paths only at the boundary where a filesystem or process API requires it.
- In the UI, normalize and compare project/worktree/session path identity through `packages/ui/src/lib/pathUtils.ts` rather than feature-local helpers.
- Compare paths with `pathsEqual()` or `isSubpath()` instead of raw string equality.
- Build POSIX-style stored or transport paths with `joinPosix()` rather than string concatenation.
- Keep long-running process readiness parsing close to `SpawnUtils` or a thin adapter layered on top of it so stop/retry behavior stays consistent across Windows, macOS, and Linux.
- Keep platform-aware behavior close to the abstraction module, not spread across feature files.

These conventions improve portability, testability, and auditability. They also reduce the chance that one fix solves Windows behavior in one feature while reintroducing the same bug in another.

## Migration Strategy

Current strategy:
- Add shared platform modules first.
- Introduce canonical path helpers before changing feature logic.
- Convert persistence and comparison code to the new helpers before deeper behavioral refactors.
- Add a one-time migration for stored settings so previously persisted Windows-style paths converge on one canonical form.
- Sweep remaining server and UI consumers incrementally rather than attempting a rewrite.

## Filesystem Abstractions

Phase 1 abstraction surface:
- `platform.*` is the only server platform authority.
- `PathUtils.*` is the canonical server path authority.
- `packages/ui/src/lib/pathUtils.ts` is the preferred UI-side normalization and comparison surface for project/worktree/session path identity.
- Persisted settings now migrate toward canonical path keys.
- Project/worktree/session matching should move to shared equality helpers instead of custom normalization snippets.

Current project-specific filesystem rules:
- Store one canonical representation for persisted path keys.
- Convert to native OS paths only at the boundary where a filesystem or process API requires it.
- Compare paths with `pathsEqual()` or `isSubpath()` instead of raw string equality.
- Build POSIX-style stored or transport paths with `joinPosix()` rather than string concatenation.
- Do not persist native-only Windows path strings as project or session identity keys.

## Process Probe/Execution Abstractions

Phase 2 abstraction surface:
- `SpawnUtils.*` is the preferred server process-spawn authority for managed OpenCode and `cloudflared` lifecycle flows.
- `SpawnUtils.spawnOnce()` is also the preferred authority for bounded server helper commands such as filesystem exec jobs and `git check-ignore` probes.
- `SpawnUtils.spawnOnceSync()` is the preferred authority for synchronous environment discovery, executable lookup probes, and package-manager detection code.
- `SpawnUtils.launchDetached()` is the preferred authority for detached OS reveal/open commands.

Current project-specific process rules:
- OpenCode daemon startup and Cloudflare tunnel startup now centralize retry/kill/readiness behavior through `SpawnUtils` instead of local child-process code.
- Filesystem helper commands now centralize one-shot command execution and git-ignore probing through `SpawnUtils.spawnOnce()`.
- Environment discovery, package-manager detection, and git helper probes now centralize sync and async process execution through `SpawnUtils`.
- Detached filesystem reveal/open commands now centralize fire-and-forget shell-outs through `SpawnUtils.launchDetached()`.
- Keep long-running process readiness parsing close to `SpawnUtils` or a thin adapter layered on top of it so stop/retry behavior stays consistent across Windows, macOS, and Linux.
- Do not add new long-running `spawn`/`spawnSync` lifecycle code when `SpawnUtils` can own the process contract.

## Terminal Abstractions

Phase 3 abstraction surface:
- `packages/web/server/lib/terminal/session.js` is the preferred authority for PTY shell preference resolution, canonical terminal cwd normalization, and Windows ConPTY-enabled PTY session creation.

Terminal-specific platform behavior should stay inside `packages/web/server/lib/terminal/session.js`.

Current terminal abstraction surface:
- `normalizeTerminalShellPreference()` is the canonical normalizer for persisted and request-level shell preference values.
- `getTerminalShellCandidates()` owns platform-aware shell candidate ordering and executable resolution.
- `createPtySession()` owns canonical cwd normalization, terminal env shaping, PTY spawn attempts, and Windows `node-pty` ConPTY enablement.

Current project-specific terminal rules:
- Persist terminal shell preference as `terminalShell` using the values `default`, `powershell`, `cmd`, `bash`, or `wsl`.
- Read persisted shell preference in terminal runtime before creating or restarting a PTY session.
- Keep per-platform shell fallback order out of `runtime.js`; route it through `session.js`.
- Only enable `useConpty` for Windows when the PTY backend is `node-pty`.
- Normalize terminal cwd through `canonicalPath()` and `toNativePath()` before handing it to the PTY backend.
- Treat any future per-session shell override as an input to the same session abstraction, not a separate feature-local spawn path.

## Git Worktree / Long-Path Abstractions

Phase 4 abstraction surface:
- `packages/web/server/lib/git/worktree-paths.js` is the preferred authority for shortened worktree root and leaf naming.
- `longPathPrefix()` remains the boundary helper for Windows direct filesystem access where Node file APIs must handle long native paths.
- Git factories should apply shared `simple-git` defaults for `core.autocrlf=false` and Windows `core.longpaths=true`.

Current project-specific Phase 4 rules:
- Build worktree roots from a shortened project-ID segment instead of the full project hash.
- Keep worktree leaf names short enough to reduce total Windows path length pressure.
- Route direct git-service file reads/writes/removals through long-path-aware native path conversion before calling Node filesystem APIs.
- Ensure newly created worktrees include a baseline `.gitattributes` rule of `* text=auto` when no equivalent rule is already present.
- Keep web/server and VS Code git runtime hardening aligned when the same worktree and git-management flows are shared by the UI.

## File Watching / Line Ending Abstractions

Phase 5 abstraction surface:
- `packages/ui/src/lib/normalizeEol.ts` is the preferred authority for line-ending normalization before diffing or content equality checks.
- `prepareForDiff()` should run at the shared diff entry boundary, not inside individual rendered diff lines.

Current project-specific Phase 5 rules:
- Normalize CRLF/CR content to LF before diff payloads enter the shared UI diff cache.
- Compare text content with `eolEqual()` when line-ending-only differences should be ignored.
- Split text for line-oriented diff preparation through `splitLines()` after normalization.
- Do not add line-ending normalization ad hoc inside Pierre line renderers or per-line UI components.
- Watcher abstraction work should only be introduced when a live server-side watch surface exists; there is no active `chokidar` surface in the current repository snapshot.

## Maintenance/Rules

Rules for future changes:
- Do not add new raw `process.platform` checks outside approved platform adapter modules.
- Do not persist native-only Windows path strings as project or session identity keys.
- Do not compare directories with `===` unless the values were already normalized by the same abstraction.
- Do not mix display formatting with filesystem access concerns in the same helper.
- Do not add new long-running `spawn`/`spawnSync` lifecycle code when `SpawnUtils` can own the process contract.
- Add tests for any new abstraction that changes equality, normalization, or path conversion behavior.
- Prefer extending an existing abstraction module over adding another feature-local helper.

Review checklist:
- Is this logic platform-specific?
- If yes, can it live in an existing platform abstraction module?
- Are persisted values canonical?
- Are filesystem calls receiving native paths?
- Are comparisons using shared helpers?
- Are process startup, retry, and stop semantics routed through `SpawnUtils` instead of ad-hoc child-process code?
- Are UI worktree/project/session matches using shared path helpers instead of local slash-trimming code?
- Does the change need Linux, macOS, and Windows verification?

This document should be updated alongside each refactor phase that changes the platform abstraction surface.
