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
  splitting inside pauses, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): a sherpa-onnx model from `local/model-catalog.js`
    (Parakeet TDT, Whisper, Qwen3-ASR) in a forked worker process. A saved
    model id the catalog no longer has counts as no pick (see Decisions).
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`). `connect()`
    runs the same URL check as every transcription
    (`normalizeCustomOpenAIBaseURL`) and the same endpoint path check
    (`normalizeEndpointPath`), so a refused host or a malformed path — any
    remote host in enterprise mode — fails before the user dictates. A
    configured `endpointPath` replaces the fixed resource path on each
    committed segment.
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
openaiCompatible?: { baseUrl, model, apiKey, endpointPath }, correct? }`. With
`correct: true` the final text goes through the correction pass first, and
`finish_accepted.timeoutMs` includes its budget (`CORRECTION_TIMEOUT_MS`).
An empty or
absent `endpointPath` keeps the OpenAI `/v1/audio/transcriptions` path.

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
- Model installation verifies required files in a staging directory before promotion. Extraction failures remove the staging directory and cached archive.

## Decisions

### Why Parakeet v3 is the default model and not v2

v2 knows English only and turns any other language into garbage, while v3
decodes 25 European languages at the same speed. On English v3 is somewhat
worse: it writes fillers ("uh", "gonna") and now and then drops a word at the
end of a phrase. A user who speaks anything but English gets text on the first
try, which matters more than the English gap.

The default applies only while the user has not picked a model (the client
sends an empty `localModel`). Someone who already has v2 installed keeps v2:
v2 was the default before, so an installed copy means they dictate with it,
and switching would cost them a download and English accuracy.

### Why misheard words are fixed by the Small Model, after the speech model

A speech model writes what a word sounded like; with unclear pronunciation it
picks a real word that makes no sense ("таку з дибав" for "такий і здибав").
A language model reading the whole sentence knows which word was meant, and
no speech model, local or hosted, sees the sentence that way.
`transcript-correction.js` sends the finished text to the Small Model once,
off by default because the text then leaves the machine. Its answer replaces
the text only when it is about as long as the input (0.6 to 1.5 times):
anything else is a model that answered or summarized instead of fixing. Any
failure, a missing Small Model or the 10 s cap returns the text as heard, so
the pass never costs the user the dictation. The prompt names colloquial
forms ("шо", "gonna") as speech to keep, because small models otherwise
"correct" them into the literary form.

### Why the language hint is part of the engine key

The client sends the user's dictation language with every session. Whisper
and Qwen3-ASR take it as a hint (`local/model-language.js`), which stops
Whisper from taking a short Ukrainian phrase for Russian; Parakeet ignores it.
Whisper reads the language from the recognizer config, not per stream, so the
worker keeps one engine per model and language and frees the copy for the
previous language unless a running dictation still uses it. A code Whisper
does not know is dropped, because sherpa-onnx exits the process on it.

### Why the catalog offers Whisper turbo and Qwen3-ASR next to Parakeet

They cover languages Parakeet does not: Whisper large-v3 turbo detects 99
languages, Qwen3-ASR covers Chinese, Japanese, Korean, Arabic, Hindi and other
Asian languages. Both are slower than Parakeet (measured on an M-series Mac with
2 threads: Parakeet decodes 1 s of audio in ~37 ms, Qwen3-ASR in ~120 ms,
Whisper turbo in ~330 ms) and peak around 2 GB of memory, so they are options
and never the default. Without a language hint Whisper detects the language
per segment and can take a short Ukrainian phrase for Russian. Qwen3-ASR has
no Ukrainian.

### Why Qwen3-ASR runs with `maxNewTokens: 512`

sherpa's default of 128 generated tokens can cut off a 25 s segment of fast
speech. With 512, 25 s segments of English and Ukrainian speech decoded in
full.

### Why retired models are deleted on startup

A model removed from the catalog (`RETIRED_LOCAL_MODEL_DIRS`) no longer shows
in Settings, so its files could not be deleted from there and would stay on
disk forever.

### Why `sherpa-onnx-node` stays on 1.x

The sherpa-onnx 2.0 release removed espeak-ng and piper-phonemize (k2-fsa/sherpa-onnx#4055),
which the Kokoro and Piper voices of local read-aloud use to turn text into
phonemes (`files.espeakData`). An upgrade has to bring those voices back first.

### Why native Windows decompression and not a JavaScript extractor

Windows' bundled tar can delegate bzip2 to an external program that the OS does not ship. On Windows, bundled 7-Zip decodes to a temporary tar file inside staging, then system tar extracts it. This keeps decompression out of the server's main thread and avoids the MSYS bzip2-to-tar pipe. macOS and Linux keep direct system-tar extraction. The temporary tar needs additional disk space and disappears with staging.
