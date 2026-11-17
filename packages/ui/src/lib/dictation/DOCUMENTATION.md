# Dictation capture and transport

## Ownership

This module owns microphone capture, chunk conversion, ordered replay and the runtime-scoped dictation connection. The server owns recognition and optional correction.

## Invariants

- PCM segments stay buffered until completion so reconnect can replay the entire stream. A failed start or send clears stream identity while retaining segments for retry, and finish surfaces the failure.
- Microphone level subscriptions bypass React state because audio-rate updates otherwise redraw the entire overlay. Capture emits mono 16 kHz PCM16LE chunks while preserving a separate live waveform signal.
- Audio context creation and resume occur inside the starting gesture before permission resolves. A stopped pending start retires its graph immediately and releases a late stream; it reports no error to an owner that has already gone away.
- Stopping flushes the tail and releases the microphone without awaiting slow context closure, allowing transcription and a new capture to proceed. Cleanup cannot leave a cancelled start pending until an error arrives.
- WebSocket URLs resolve at connection time, and a runtime switch closes the socket and fails outstanding dictations. URL auth is minted before upgrade; a cold recognition engine has startup headroom, and readiness waits for the server's frame rather than socket open alone. Socket close supplies the useful failure reason, with an error fallback if close never arrives.
