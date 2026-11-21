# Dictation capture and transport

## Ownership

This module owns microphone capture, chunk conversion, ordered replay and the runtime-scoped dictation connection. The server owns recognition and optional correction.

## Invariants

- PCM segments stay buffered until completion. Reconnect resumes the same dictation and replays from the server's last acknowledged sequence; a fresh stream can replay from the first segment. A failed start retains segments for retry, and finish surfaces the failure.
- Microphone level subscriptions bypass React state because audio-rate updates otherwise redraw the entire overlay. Capture emits mono 16 kHz PCM16LE chunks while preserving a separate live waveform signal.
- Audio context creation and resume occur inside the starting gesture before permission resolves. A stopped pending start retires its graph immediately and releases a late stream; it reports no error to an owner that has already gone away.
- Stopping flushes the tail and releases the microphone without awaiting slow context closure, allowing transcription and a new capture to proceed. Cleanup cannot leave a cancelled start pending until an error arrives.
- WebSocket URLs resolve at connection time, and a runtime switch closes the socket and fails outstanding dictations, ending a recording as failed so its audio reaches the new host only through an explicit retry; a dial that was still opening at the switch is closed when it becomes ready, never installed. URL auth is minted before upgrade, inside the connect timeout, so a stalled token fetch cannot hold the reconnect budget open; a cold recognition engine has startup headroom, and readiness waits for the server's frame rather than socket open alone. Socket close supplies the useful failure reason, with an error fallback if close never arrives.
- While recording or finishing, a dropped socket retries within a 15 s budget. Pending starts are sent on readiness, and the sender resends a pending finish only after the replay on that socket drained; a replay cut off by another drop leaves the finish to the resume on the next socket. A new microphone segment resumes only a stream the client still keeps alive, so the tail flushed after a failed or switched-away recording stays in the buffer. A dictation has at most one start in flight: a resume while the resent start waits for its ack joins it, because a second entry would replace the first and its timeout would later fail the recording.
- An unsolicited stream error reaches the capture hook, which stops the microphone and moves a recording to failed with its audio and partial transcript kept for retry or salvage. When the budget runs out, every open dictation gets such an error, so a recording with nothing pending still ends. During a finish the finish itself reports the failure, once.
- Cancel ends a dictation in the client even while the socket is down: its pending start and finish are dropped, so a reconnect neither resends them nor keeps dialing for it, and a start that answers after the cancel reports nothing.
