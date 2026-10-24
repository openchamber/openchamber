# Android reading audio focus

## Ownership

This adapter owns a reading-scoped lease on the app-local Android `ReadingAudioFocus` plugin. `useMessageTTS` supplies stop and completion events; the provider hooks own synthesis and playback. The native plugin owns the Android focus request and rejects releases for other reading ids.

## Invariants

- Every provider checks reading ownership after preparation and before scheduling audible audio. A replaced reading cannot start late.
- Android requests transient focus without ducking immediately before the first chunk. Denial or bridge failure prevents playback. Focus remains held across chunks and app switches.
- End, error, stop, replacement, unmount, and native teardown release focus. Reading ids prevent stale releases and focus-loss events from affecting a newer reading.
- Any focus loss stops speech without automatic resumption. No delayed focus request is queued.
- Web, Electron, VS Code, hosted mobile, and iOS retain their existing audio policy. Android integration uses an app-local plugin, like the existing clipboard and image-paste adapters; it adds no server API or dependency.

## Decisions

### Why focus belongs to a reading

Provider requests can finish late and a reading may span several audio chunks. A reading-scoped lease holds focus across synthesis gaps and lets old callbacks release only their own native request.

### Why focus loss stops speech

The current providers share a stop operation but have no common resumable position. Stopping prevents speech from competing with calls or newly started media without replaying a reply when focus returns.
