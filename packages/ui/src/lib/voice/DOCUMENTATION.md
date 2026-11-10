# Read-aloud playback

## Ownership

`useMessageTTS` coordinates message readings and the provider hooks synthesize and play audio. `useAutoReadAloud` decides which completed reply may start automatically. `activeReading` owns replacement and stop controls shared by manual and automatic readings.

## Invariants

- In Capacitor mobile, automatic readings require a visible document and a confirmed active app. Replies skipped in the background are consumed locally without taking a cross-window claim. Web, desktop, VS Code, and hosted mobile allow automatic readings in the background.
- A native mobile background transition invalidates a pending automatic start even if the user returns before preparation completes. Session changes, replacement, and disabling automation also invalidate pending starts on every runtime.
- Providers call `beforePlayback` after asynchronous preparation and before scheduling audible audio. Once the first chunk starts, foreground changes do not prevent subsequent chunks.
- Manual readings do not require foreground eligibility. A replaced reading must never begin late.

## Decisions

### Why eligibility is checked at playback

Claims, summarization, voice discovery, and synthesis can finish after the app backgrounds. Checking only when a reply arrives permits a delayed background start on native mobile. Native app lifecycle is needed because document visibility alone is not dependable in every WebView. Background eligibility is restricted only in the native mobile shell so web and desktop users can keep listening while working elsewhere.
