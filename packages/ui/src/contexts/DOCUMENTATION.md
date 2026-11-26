# Shared UI contexts

## Ownership

This module owns React providers for runtime APIs, cached file reads, theme preferences, diff worker pools, and fireworks. Runtime adapters own platform I/O. Theme parsing, palettes, and CSS generation belong to `../lib/theme`; persistence owns settings synchronization.

## Invariants

- Theme storage is scoped by runtime endpoint so windows connected to different instances cannot overwrite or adopt each other's preferences through shared localStorage.
- Malformed or partial scoped theme entries are failures. They allow the caller to use the legacy seed or retain current preferences without treating corruption as a valid default.
- Cross-window adoption preserves current preferences when values already match, preventing adoption loops. Storage events for another runtime leave the current theme unchanged.
- Boot uses the scoped theme entry or seeds it from legacy global keys, preserving the last-known theme on the first scoped write. An endpoint switch uses the destination's stored theme when available and otherwise preserves the current object until authoritative settings arrive.
- Only settings syncs with `adoptTheme` apply theme values: the bootstrap read, and the live refresh that follows a settings-file change or a control-stream reconnect (`hooks/useSettingsFileSync.ts`). Mid-session save echoes never set `adoptTheme`, because they can contain another window's theme, defaults, or stale values. Absent theme fields independently retain current preferences; the incoming settings document is already sanitized.
- An adopted selection whose palette is not loaded yet keeps the current theme on screen and stays pending while custom themes reload; it applies when the palette arrives, and a local pick, another window's selection, a newer settings read or a runtime switch cancels it. A save echo leaves it pending.
- Only explicit UI theme changes authorize server writes. Mounting, runtime switches, OS mode changes, and adopting synchronized preferences must not write a default or adopted theme back to the server.
- Global theme keys remain cosmetic last-writer-wins hints for pre-React splash pages and the Android status bar, plus a migration seed. Scoped preferences and per-instance server settings own the app's theme. Desktop startup colors go directly to the shell because they belong to that installation.
- Custom themes take precedence over built-ins with the same ID. Development theme events apply validated built-in edits without reloading the page.
- Theme reloads run after event-stream reconnection because folder-change events can be missed. A missing selection triggers one fetch per runtime and missing-ID set so another window's import can appear without endless polling for deleted or invalid IDs. The UI auth gate owns prompting after a 401; theme loading adds no retry loop.
- The root's inline `color-scheme` follows theme changes after the splash. A stale scheme leaves native controls in the previous mode and can make extension frames paint an opaque canvas when their scheme differs from the page.
- A successful theme import invalidates older reloads so they cannot erase the saved item. A selection or newer import made during an upload takes precedence over that upload's activation.
- Disposed file-cache owners reject reads. Endpoint changes invalidate cached content and advance its generation while keeping the owner active because `apis.files` usually retains its identity across switches.
- Diff theme registration uses deferred imports to keep the Pierre runtime out of the eager startup graph. Each diff view also registers its own themes so rendering order remains valid before provider registration resolves.
- Fireworks calls without a mounted overlay are no-ops, allowing Mini Chat and other consumers to use the same hook without displaying celebrations.

## Decisions

### Why retain all runtime theme entries and not cap the index

Each entry is about 150 bytes and there is at most one per distinct runtime visited from the origin. Eviction saves trivial space while discarding the last-known theme of rarely visited instances, so retention stays unbounded even though the settings mirror caps its index at 5 runtimes.

### Why create cache owners in an effect and not useMemo

React Strict Mode disposes and remounts effects, so each effect setup creates a fresh owner. Memoizing an owner across cleanup reuses a disposed cache and breaks subsequent text-file opens, while binary files can conceal the failure because they skip the pre-read.

### Why defer diff warmup and not initialize pools during mount

Static Pierre runtime imports pull Highlights and fallback Shiki into the eager graph, and pool initialization creates workers and a main-thread highlighter before a diff is visible. Heavy modules load on demand, pool and chat Highlights warmup waits for startup idle to avoid competing with initial load, and language preloading stays small because workers load other languages on demand.

### Why highlight small inputs on the main thread and not send every input to a worker

The 64 KiB threshold lets small files and diffs paint highlighted in their first frame: Highlights tokenizes that amount in about a millisecond, less than a worker round trip. Shiki is slower, so the threshold remains small.
