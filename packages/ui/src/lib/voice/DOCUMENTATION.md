# Read-aloud playback

## Ownership

`useMessageTTS` coordinates message readings and the provider hooks synthesize and play audio. `useAutoReadAloud` decides which completed reply may start automatically. `activeReading` owns replacement and stop controls shared by manual and automatic readings.

## Invariants

- In Capacitor mobile, automatic readings require a visible document and a confirmed active app. Replies skipped in the background are consumed locally without taking a cross-window claim. Web, desktop, VS Code, and hosted mobile allow automatic readings in the background.
- A native mobile background transition invalidates a pending automatic start even if the user returns before preparation completes. Session changes, replacement, and disabling automation also invalidate pending starts on every runtime.
- Providers call `beforePlayback` after asynchronous preparation and before scheduling audible audio. Once the first chunk starts, foreground changes do not prevent subsequent chunks.
- Manual readings do not require foreground eligibility. A replaced reading must never begin late.
- On desktop Linux, browser speech rejects an empty voice list after voice discovery, before taking playback ownership. Callers finish the reading on rejection so a missing speech-dispatcher backend cannot leave it marked as playing. Other platforms, Android included, go on to speak with the default voice, because an empty list there does not prove synthesis is unavailable.
- Android WebViews can report a Linux platform. Desktop Linux detection excludes Android so its empty voice list does not prevent default-voice playback.
- Only 1 reading is active across the app. Whole-message, mobile action-sheet, and selection controls for the same message share a key, so each can show and stop the reading regardless of which control starts it. Completion of a replaced or stopped reading cannot clear its successor.
- Conversation mode requires an explicit microphone start. Enabling it only permits listening to resume after speech; playback pauses recognition to prevent the microphone from transcribing synthesized speech.

## Decisions

### Why eligibility is checked at playback

Claims, summarization, voice discovery, and synthesis can finish after the app backgrounds. Checking only when a reply arrives permits a delayed background start on native mobile. Native app lifecycle is needed because document visibility alone is not dependable in every WebView. Background eligibility is restricted only in the native mobile shell so web and desktop users can keep listening while working elsewhere.

### Why recognition starts directly and not after a permission preflight

Recognition starts synchronously in the user gesture path to preserve mobile Safari's permission eligibility. Embedded runtimes can omit `mediaDevices` or reject a `getUserMedia` preflight while recognition can still request permission itself; explicit permission preparation remains separate, and resume assumes permission is already granted.

### Why audio unlock uses a gesture and not a playback retry

Audio context resume and explicit unlock run from a user gesture to satisfy browser autoplay restrictions. Unlock plays silent audio and speaks a silent mobile utterance so later synthesis can proceed; synthesis also leaves 50 ms after context resume for audio readiness.

### Why sanitization preserves inline words and not code blocks

Sanitization supplies speakable text when server summarization is skipped. Fenced code is unreadable aloud, but inline code often contains meaningful words such as a branch name. Absolute paths are removed while interword slashes in names such as `iOS/Android` and `origin/main` remain speech.

### Why speech keeps line boundaries and not flattened whitespace

Headings and list items need their line breaks because TTS chunking uses them as hard boundaries. Lines ending in a letter or digit also receive a period because browser synthesis and macOS `say` can treat a bare newline as a space and run adjacent items together.
