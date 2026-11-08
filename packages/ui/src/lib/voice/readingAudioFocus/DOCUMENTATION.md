# Android reading audio focus

## Ownership

This adapter owns a reading-scoped lease on the app-local Android `ReadingAudioFocus` plugin. Message readings and Settings voice previews share `startFocusedReading`, including ownership, playback guards, and cleanup. The provider hooks own synthesis and playback. The native plugin owns the Android focus request and rejects releases for other reading ids.

## Invariants

- Every provider checks reading ownership after preparation and before scheduling audible audio. A replaced reading cannot start late.
- Android requests transient focus without ducking immediately before the first chunk. Denial or bridge failure prevents playback. Focus remains held across chunks and app switches.
- End, error, stop, replacement, unmount, and native teardown release focus. Reading ids prevent stale releases and focus-loss events from affecting a newer reading.
- Transient loss, including MAY_DUCK, pauses playback. Gain resumes the same player. Permanent loss stops it. Preparation that finishes during a pause waits for gain and rechecks ownership before starting. No delayed focus request is queued.
- Web, Electron, VS Code, hosted mobile, and iOS retain their existing audio policy. Android integration uses an app-local plugin, like the existing clipboard and image-paste adapters; it adds no server API or dependency.

## Decisions

### Why focus belongs to a reading

Provider requests can finish late and a reading may span several audio chunks. A reading-scoped lease holds focus across synthesis gaps and lets old callbacks release only their own native request.

### Why transient loss pauses speech

Suspending the provider's AudioContext preserves source positions and scheduled chunks. HTML audio previews use pause/play. This keeps a navigation prompt or call from discarding a long reply. Permanent loss releases the lease and stops playback. Browser speech uses the synthesis engine's pause/resume where supported; Android WebView does not expose speechSynthesis, so its browser provider remains unavailable.
