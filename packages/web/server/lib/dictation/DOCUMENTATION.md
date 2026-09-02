# Dictation module

Server-authoritative speech-to-text for the chat composer, plus local
text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64) over a
WebSocket while the user speaks; the server buffers them and transcribes each
segment exactly once, when the segment is committed.

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
  Chunk reordering by `seq` + ack, resampling to the provider rate, segment
  splitting, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx Parakeet TDT in a forked worker process.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`).
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and segment session (one decode per committed segment),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
- `audio.js` — PCM16 helpers: format parsing, peak, WAV wrapping, streaming
  linear resampler.

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
(60 s) the manager commits on the first silent chunk, so cuts land at a pause
rather than mid-word; `segmentMaxSeconds` (90 s) is a hard cap for speech with
no pause in it. Client chunks are ~1 s, so "silent chunk" is roughly a second
of silence.

The bounds exist because Parakeet is a full-attention conformer: decode cost
and peak memory grow quadratically with segment length. Measured on Parakeet
v3 int8 with 2 threads: 60 s took 2.1 s and +90 MB, 180 s took 9.3 s and
+490 MB, 300 s took 21.3 s and +1.5 GB. Committed segments decode while the
user is still speaking, so only the tail is left to transcribe on stop.

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
