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

- `runtime.ts` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.ts` — `DictationStreamManager`, one per runtime.
  Chunk reordering by `seq` + ack, resampling to the provider rate, segment
  splitting inside pauses, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.ts` — provider resolution and readiness. Providers:
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
openaiCompatible?: { baseUrl, model, apiKey, endpointPath, prompt }, correct? }`. With
`correct: true` the final text goes through the correction pass first, and
`finish_accepted.timeoutMs` includes its budget (`CORRECTION_TIMEOUT_MS`).
An empty or
absent `endpointPath` keeps the OpenAI `/v1/audio/transcriptions` path. A
non-empty `prompt` goes out as the multipart `prompt` field on every committed
segment; an empty or absent one sends no field. The local provider takes no
prompt.

### Resume after a dropped connection

A dictation outlives its socket. The runtime keeps one manager for all
connections, and a stream whose socket closed stays alive for
`DICTATION_RESUME_GRACE_MS` (30 s). The client reconnects within that window and
sends `start` again with the dictation id it already had and the same options;
the server answers with `ack {ackSeq}` carrying its last acked seq and creates
no new session. A `start` repeated while the first one is still creating its
session (a local model can take seconds to load) waits for that session's ack
instead of opening a second one; a cancel, a start with other options, the end
of the grace period or shutdown closes a session that finishes loading after
it. The client continues at `ackSeq + 1`, so only the audio sent
during the interruption is uploaded and nothing already decoded is decoded
again. A repeated `start` with changed options, a different `format`, or an id
the server no longer holds starts a fresh stream and acks `-1`, which makes the
client replay from the first segment.

A stream that already sealed its `finish` is resumed too: it is not done until
`final` went out, and resuming it keeps the finished audio instead of starting
an empty stream. Sealing and the final timeout are idempotent, so the repeated
`finish` the client sends after the reconnect only renews the wait.

A dictation that was already finished while the socket was gone is answered
from a small cache: the runtime keeps the last `final` texts for
`DICTATION_FINAL_CACHE_TTL_MS` (30 s, dropped on access and by an unref'd
timer). A `start` naming such an id gets `final` with the same text and no new
stream, so the text is not lost to a reconnect that came too late.

## Segmentation

A dictation is one segment unless it runs long. For local models the manager
cuts at the first pause after 15 s, or at 25 s without a pause. For the
OpenAI-compatible provider those bounds are 60 s and 120 s, so its transcription
has more context. At 16 kHz PCM16, 120 s is under 4 MB of WAV audio, below
OpenAI's 25 MB upload limit. Other compatible servers may have lower limits.
The finalization deadline includes audio already committed but still awaiting a
transcript, as well as the uncommitted tail.

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

- The fork target `local/worker-process.js` stays a JavaScript bootstrap and
  registers the source resolver before loading `worker-runtime.js`. Forked
  processes have their own resolver state even when the parent loaded the hook.

- Never load `sherpa-onnx-node` in the main server process.
- Transcription happens on commit only; sessions never emit non-final
  transcripts. The `partial` messages a client receives are the concatenation
  of already-committed segments, and exist so a dictation that fails partway
  can be salvaged instead of losing minutes of speech.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- A dictation outlives its socket. Audio stays on the device until the final
  transcript arrives, and a reconnect resumes the stream the server still
  holds: same dictation id, server answers `ack` with its last acked seq, the
  client sends from the next one. A resumed stream never decodes the same
  segment twice.
- Three frames can die with the socket and must be repeated on the next
  connection: `start`, `finish`, and `final`. A finished dictation is held for
  30 s so a client that never saw `final` can ask again instead of opening a
  stream with no audio left.
- The stream manager lives per runtime, not per socket. One per socket made a
  resume impossible, because the close dropped the stream it had to continue.
- A dictation id belongs to this one local host. The endpoint is served by the
  host's own process, ids are random per dictation
  (`dic_<time in hex><random>`), and the UI has one user, so any socket that
  reaches the endpoint may resume, finish or cancel any id it names; nothing
  checks ownership. That is a conscious limit, not a defect. If the server ever
  serves several users, a socket needs an identity and every stream has to be
  bound to it: record the owner on `start`, compare it on `start` (resume),
  `chunk`, `finish` and `cancel`, and answer a mismatch with a non-retryable
  error instead of touching the stream.
- Model files live under `~/.config/openchamber/speech-models`.
- Model installation verifies required files in staging before promotion because the installed check only tests file presence. Extraction failures remove staging and the cached archive. Partial destination directories are removed before retry; recognized model-load or Protobuf failures remove the installed copy so the next attempt can download clean files.
- Segment byte and peak counters reset when the manager issues a commit. A delayed `committed` event must preserve audio received since that commit, or the tail can be mistaken for silence and discarded.
- Finalization waits for every commit the manager issues to be acknowledged and for every segment's final transcript. Counting only echoed events can omit a commit still in flight when the client finishes.
- The correction deadline covers model resolution and generation because the Small Model's own generation budget starts after resolution and cannot bound a stalled lookup. The finalization budget includes the correction pass after transcription.
- A correction result is emitted only while its original stream state is still registered. Cancellation or timeout makes a late result obsolete.
- Request-supplied transcription keys remain accepted for older clients that predate server-side voice-key storage. The stored key supplies the fallback.
- Model deletion is refused during download. Deleting files leaves an already-loaded worker engine alive until idle shutdown; selecting the model again requires its files to be downloaded again.
- CPU-quota discovery distinguishes an unreadable hierarchy from an unlimited one and checks visible ancestors. A container can hide the process's listed cgroup path while exposing its limit at the mount root.
- Extraction diagnostics retain only the stderr tail so a failing subprocess cannot grow the server's memory without bound.

## Decisions

### Why stream event fields remain unchecked

The stream manager uses TypeScript but does not validate forwarded worker event
fields. Segment ids remain unknown map keys, transcript values remain unknown
until the existing array join converts them, and final flags retain their
truthiness test. The injected session contract describes the properties consumed
by the listeners without claiming their values are strings or booleans.

WebSocket start fields likewise remain unknown. Correction stringifies its
language hint when constructing the prompt, so its options accept the unchecked
hint the manager already forwards. Rejections retain inherited and non-string
message values, including primitive boxing and the original truthy fallback.

Contiguous audio chunks are occupied map entries. A missing entry still fails
rather than skipping audio. A session result without a session and a correction
state without its callback still fail with TypeError. RMS indexing substitutes
NaN only for missing numeric samples, preserving JavaScript's comparison result.

### Why provider options stay unchecked until use

WebSocket start options carry unchecked fields. The service keeps the truthiness
defaults for the compatible configuration, API key and remote language hint.
The URL and path normalizers check their inputs. The local session forwards the
language hint via IPC, where model-language resolution checks it. The worker
client accepts explicitly absent speaker and speed values because it already
forwards them in the speech request.

The installed OpenAI SDK's constructor leaves a non-string, non-function API key
unset for authentication. Its multipart encoder handles model and language fields
with the same conversion and failure rules as other form fields. The local SDK
declaration describes those inputs without promising that authentication or an
upstream request will succeed.

Status still fails if an id from the catalog's enumerated keys has no entry.
Download failures retain a truthy rejection message verbatim, and the corrupt
model check coerces that message to a string only for the regex match.

### Why the runtime retains unchecked property values

HTTP speech fields and WebSocket messages remain unchecked until their existing
field checks run. WebSocket start options accept arrays as well as objects.
The speech-body and rejection-message predicates establish only non-nullish
property access, including JavaScript's primitive boxing; they do not promise
string fields or require own properties. Rejection messages remain arbitrary
values, with the original truthy-message fallback.

`Number.isInteger` remains the speaker-id acceptance check. The speech-error
predicate retains the service result's truthiness check and distinguishes its
readiness errors from its audio result. The WebSocket server uses default client
tracking; a missing client set still throws rather than silently skipping cleanup.

The Small Model's JavaScript destructuring infers required properties for its
optional arguments. Correction supplies explicit `undefined` for the unused
arguments; the generation function reads only the destructured values, so these
remain the same as absent arguments. Service status and speech option types admit
the explicit `undefined` values the runtime already supplies.

### Why audio indexing preserves missing samples

Typed-array indexing can produce `undefined`. Arithmetic on a missing sample
produces `NaN`, including fractional RMS frame indices and invalid resampler
positions. Numeric calculations retain that outcome instead of substituting
silence or throwing. The resampler carry retains its original null/undefined
distinction.

IPC buffer views can start at odd byte offsets. PCM helpers copy those views
before creating an `Int16Array`, which requires an aligned start offset.

The audio helpers import no external modules. Their inputs are PCM buffers,
format strings and numeric rates supplied by the stream manager and local
recognizer/worker. The correction helper receives finished text, an optional
language and an injected Small Model generator. Its deadline, generation
failure and implausible corrections still fall back to the original text.

### Why Parakeet Ultra is the default model and not v3 or v2

v2 knows English only and turns any other language into garbage, while v3
decodes 25 European languages at the same speed. Ultra is Moondream's
post-trained v3: same architecture, size and speed, fewer errors. On 300
FLEURS clips per language through our own recognizer (int8, 2 threads), WER
fell from 9.24% to 8.01% on Ukrainian and from 6.85% to 5.50% on English.
Nemotron 3.5 ASR Streaming, the other candidate, scored 19.5% and 13.5% on the
same clips.

k2-fsa publishes no sherpa export of Ultra, so the archive is OpenChamber's
own, in the `asr-models` pre-release: the sherpa v3 export script run on the
Ultra `.nemo`. Its transcripts match an independent export word for word on
all 600 clips. A pre-release keeps the desktop updater, which reads the latest
full release, away from it.

To export another model of the Parakeet v3 architecture, run sherpa-onnx's
`scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py` on its `.nemo` in a Python
3.11 venv with `nemo_toolkit[asr]`, `numpy<2`, `pyarrow<20`, `onnx==1.17.0`
and `onnxruntime==1.17.1`. The encoder's `url` metadata must contain `tdt`,
or sherpa-onnx 1.13 refuses the model. Pack it as a `.tar.bz2`, upload it to
the `asr-models` pre-release, and point the entry's `archiveUrl` in
`local/model-catalog.js` at it.

The default applies only while the user has not picked a model (the client
sends an empty `localModel`). Someone who already has v2 installed keeps v2:
v2 was the default before, so an installed copy means they dictate with it,
and switching would cost them a download and English accuracy. Someone with
v3 installed, the default before Ultra, keeps dictating with v3 while Ultra
downloads in the background, so the switch never blocks a dictation.

A failed background Ultra upgrade waits for the next server start, so each
dictation does not restart the same failing download.

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

### Why the transcription prompt is sent to any model and not gated by model name

The server model is free text, and the same name can mean different engines on
different servers, so OpenChamber cannot tell which models accept a prompt.
The prompt goes out whenever the user filled it; a model without prompt
support ignores it or the server rejects the request, and that error reaches
the user like any other transcription error. A model catalog or an automatic
retry without the prompt would guess and hide what the server answered.

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

### Why engine threads follow the CPU quota and not only the core count

The worker is its own process and exits after its idle TTL, so a decode can use
the host's cores without slowing the server's event loop: on a 32-core host a
7.4 s Parakeet clip decoded in 409 ms at 2 threads and ~200 ms at 8. The count
is the CPUs the process may run on, capped at 8 (`engine-threads.js`).
`availableParallelism()` alone reports the affinity mask, not a Linux cgroup
CPU quota, so a container limited to 2 CPUs on a many-core host would run 8
threads and be throttled; the quota bounds the count too. When a Linux host's
quota cannot be read, the worker keeps the old 2 threads. The memory figures in
this document were measured at 2 threads.

### Why retired models are deleted on startup

A model removed from the catalog (`RETIRED_LOCAL_MODEL_DIRS`) no longer shows
in Settings, so its files could not be deleted from there and would stay on
disk forever.

### Why `sherpa-onnx-node` stays on 1.x

The sherpa-onnx 2.0 release removed espeak-ng and piper-phonemize (k2-fsa/sherpa-onnx#4055),
which the Kokoro and Piper voices of local read-aloud use to turn text into
phonemes (`files.espeakData`). An upgrade has to bring those voices back first.

### Why the platform package is resolved from `sherpa-onnx-node`'s own tree

The platform package is an optional dependency of `sherpa-onnx-node`, so an
isolated install (bun's default layout, pnpm) keeps it inside that package's
`node_modules`, where resolving from `local/` fails. The fallback that loads
`sherpa-onnx.node` directly runs only after `require('sherpa-onnx-node')`
throws, so a resolver that gives up there leaves the fallback unable to find
the addon. Resolving from the wrapper's own `createRequire` first, then from
this module, keeps the hoisted npm layout working and makes the fallback
reachable in the isolated one. The Electron `app.asar` to `app.asar.unpacked`
rewrite applies to whichever directory comes back.

### Why native Windows decompression and not a JavaScript extractor

Windows' bundled tar can delegate bzip2 to an external program that the OS does not ship. On Windows, bundled 7-Zip decodes to a temporary tar file inside staging, then system tar extracts it. This keeps decompression out of the server's main thread and avoids the MSYS bzip2-to-tar pipe. macOS and Linux keep direct system-tar extraction. The temporary tar needs additional disk space and disappears with staging.

### Why commits are acknowledged before decoding and not after it

The worker opens the next segment and acknowledges the committed one before
scheduling synchronous inference on the next event-loop turn. Waiting for decode
would consume the parent's IPC request deadline and hold later audio packets;
audio and commit requests have no per-request timeout, their results arrive as
session events, and worker exit rejects pending requests.

### Why pauses require 200 ms and not a single quiet frame

A 200 ms quiet run exceeds closures inside words while still detecting short
sentence pauses. An absolute quietness minimum tolerates small nonzero samples
in digitally silent input.

### Why Ukrainian speech uses Lada and not a larger model

Lada handles mixed Cyrillic and Latin text, including file and product names.
The larger `ukrainian_tts-medium` character model produces noise through Piper's
espeak phonemization, and `vits-coqui-uk-mai` drops Latin words.

### Why native library paths are set explicitly and not left to system lookup

The native addon depends on shared libraries in its platform package, so the
loader prepends that directory to the platform's dynamic-loader search path
before requiring the addon. Finding the addon alone does not make its shared
libraries discoverable.

### Why the worker shuts down while idle and not only on server exit

Idle shutdown releases the ONNX runtime's memory while speech is unused. TTS
uses a longer request budget because long text on slow hardware can exceed the
ordinary IPC deadline.
