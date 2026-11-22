# Dictation module

Server-authoritative speech-to-text for the chat composer, plus local
text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64) over a
WebSocket while the user speaks; the server buffers them and transcribes each
segment exactly once, when the segment is committed.

Inbound frames are capped at `DICTATION_WS_MAX_PAYLOAD_BYTES` (512 KiB),
passed as `maxPayload` to the WS server and checked again by the connection's
`message` handler: Node's `ws` enforces `maxPayload` while parsing, but Bun
may not, so the handler closes an over-cap frame with 1009 before parsing it.
The handler cannot prevent the first over-cap allocation under Bun.

Transcription is deliberately not incremental. Parakeet is an offline model
trained on whole utterances, so re-decoding the growing buffer to animate a
live transcript costs O(n^2) work for a result the final decode replaces. The
composer shows no text while recording and inserts the full transcript on
stop.

Local TTS (Kokoro and Piper/VITS via sherpa-onnx OfflineTts) runs in the same
worker process and is exposed as `POST /api/dictation/tts/speak` (JSON
`{text, speakerId?, speed?, model?, language?, languageSample?}` → WAV bytes; 503 with
`reasonCode` while the model is downloading). TTS models live in the same
catalog/downloader as STT models (`local/model-catalog.js`
`LOCAL_TTS_MODEL_CATALOG`) and are managed by the same status/download/delete
routes.

Each TTS catalog entry declares the `languages` it speaks. With
`language: 'auto'` the service detects the language of `languageSample` — the
whole message the chunk belongs to, sent by the client with every chunk — or
of `text` when no sample is given
(`../tts/language-detect.js`, script plus function-word scoring, no
dependencies) and keeps the caller's model when it speaks that language;
otherwise it switches to the catalog model for the language, downloading it on
first use like any other model, and starts from that model's default speaker
(`defaultSpeakerByLanguage`) instead of the caller's speaker id. A language no
catalog model covers keeps the caller's model, so text is always spoken. The
response carries `X-Speech-Model` and `X-Speech-Language`.

## Ownership

- `runtime.js` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.js` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack (the reorder buffer is bounded at
  8 MiB of buffered bytes; crossing the bound fails the stream with a
  retryable error instead of retaining chunks behind a missing `seq`),
  resampling to the provider rate, segment
  splitting inside pauses, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx Parakeet TDT in a forked worker process.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`). `connect()`
    runs the same URL check as every transcription
    (`normalizeCustomOpenAIBaseURL`), so a refused host — any remote one in
    enterprise mode — fails before the user dictates.
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and segment session (one decode per committed segment),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
- `audio.js` — PCM16 helpers: format parsing, peak, per-frame RMS, WAV
  wrapping, streaming linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

`options` in `start` carries the client-selected provider config:
`{ provider: 'local' | 'openai-compatible', language?, localModel?,
openaiCompatible?: { baseUrl, model, apiKey } }`.

## Segmentation

A dictation is one segment unless it runs long. Past `segmentMinSeconds`
(15 s) the manager cuts inside the first pause it finds, so cuts land between
words; `segmentMaxSeconds` (25 s) is a hard cap for speech with no pause in it.

Pauses are found inside each ~1 s client chunk, not at chunk boundaries: the
chunk is scored in 50 ms RMS frames; a frame is quiet when it is close to the
stream's noise floor (the quietest frame in the last ~10 s, so a fan or a
boosted mic does not hide every pause and a silent first second from a gated
mic is soon forgotten) and well below its loudest frame (so soft speech does
not pass for a pause), a pause is a quiet run of at least 200 ms, and the cut
goes into the middle of that run — a pause that straddles two chunks still
counts, cut at the chunk boundary when its middle already went by. At the
hard cap the cut goes into the quietest frame of the chunk that crosses it.
Bytes before the cut end the committed segment, bytes after it start the next
one; the client's `seq` and ack are untouched because the whole chunk is
consumed either way.

The bounds exist because Parakeet is a full-attention conformer: decode cost
and peak memory grow quadratically with segment length. Measured on Parakeet
v3 int8 with 2 threads: 15 s ≈ 0.6 s, 60 s ≈ 2.9 s / 1.17 GB, 90 s ≈ 4.9 s /
1.60 GB, and a single ~165 s+ segment aborts the worker (native `onnxruntime`
`SIGTRAP` in `BFCArena::Extend`). Short segments keep a long dictation far from
that cliff: 24 × 25 s stayed flat at ~1.17 GB. Committed segments decode while
the user is still speaking, so only the tail is left to transcribe on stop.

## Invariants

- Never load `sherpa-onnx-node` in the main server process.
- Transcription happens on commit only; sessions never emit non-final
  transcripts. The `partial` messages a client receives are the concatenation
  of already-committed segments, and exist so a dictation that fails partway
  can be salvaged instead of losing minutes of speech.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- Model files live under `~/.config/openchamber/speech-models`.
- Every catalog archive carries a pinned byte size and SHA-256
  (`local/model-catalog.js`); the downloader aborts a stream the moment it
  passes the pinned size, refuses a completed download whose digest differs,
  and re-verifies a cached archive against the pins before reusing it. An
  entry without pins is never downloaded.
- Worker stderr is decoded as a byte stream and flushed before an exit error is
  built. The retained tail is at most 2,000 UTF-16 code units and starts on a
  complete Unicode character.
- Tar stderr is decoded as a byte stream and flushed on process close before an
  extraction error is built. Its retained tail is at most 4,096 UTF-16 code
  units and starts on a complete Unicode character.

## Decisions

### Why worker stderr uses a streaming decoder

Child-process stderr can split a UTF-8 character across pipe chunks. A
`StringDecoder` carries incomplete bytes to the next chunk and flushes them on
close before the exit handler builds its error.

### Why worker creation is injectable

The client defaults to the real fork, while tests inject a fake worker to drive
stderr chunk boundaries and close timing without starting the speech process.

### Why tar stderr uses a streaming decoder

The tar diagnostic includes the archive member name, and it becomes the user's
extraction error. A `StringDecoder` preserves characters split across stderr
chunks; the injected spawn lets tests drive those byte boundaries without
changing the timeout or process-kill behavior.
