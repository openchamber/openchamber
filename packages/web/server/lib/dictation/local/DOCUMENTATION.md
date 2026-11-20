# Local speech engines

## Ownership

This folder owns the local model catalogs, model installation, native-addon
loading, speech engines and forked-worker IPC. The parent dictation service owns
provider selection and readiness.

## Invariants

- Relative imports retain `.js` specifiers. `worker-process.js` stays a JavaScript
  bootstrap that installs source resolution before importing the worker runtime.
- Model-id guards accept only strings that are own catalog keys. Catalog lookup,
  language fallback and default-speaker acceptance retain their existing runtime
  checks, including `Number.isInteger`.
- A missing cgroup file differs from an unreadable hierarchy. The tightest
  visible ancestor quota wins; an unreadable Linux quota keeps 2 threads.
- The loader mutates the supplied environment. Windows environment keys are
  case-insensitive. Native binaries and their libraries use `app.asar.unpacked`.
- Model extraction verifies staging before promotion and removes failed staging
  and cached archives. The installed check alone tests file presence.

## Decisions

### Why native loading does not promise wrapper constructors

`sherpa-onnx-node` 1.13.8 has JavaScript and JSDoc but no declaration entry.
The wrapper and raw addon both expose the native version string. The loader
returns either module as-is and leaves the constructor fields unchecked.
The raw addon exports `createOfflineRecognizer` and `createOfflineTts`; it
does not expose the wrapper's `OfflineRecognizer` and `OfflineTts` classes.

Both engines check that the wrapper's class is a function before
constructing it. The recognizer then throws the same `TypeError` the runtime
would for a non-constructor; TTS throws its own message that tells the pinned
wrapper's class from the raw addon's missing export. The native recognizer,
its streams and results are declared by the fields the engine reads and stay
unchecked, as the TTS engine's are. Kokoro requires a speaker bank and can name
additional catalog file roles for lexicons. VITS, including Piper, accepts an
optional espeak-ng data directory. The catalog types file roles as a plain
dictionary, so the worker builds the TTS configuration through `ttsConfigOf`,
which refuses a model type other than VITS or Kokoro and a missing model,
tokens, espeak or voices file by name; the recognizer refuses a missing role
the same way instead of passing `undefined` to `path.join`.

The recognizer decodes a whole segment at a time and raises the gain of a
quiet segment, up to 50 times, toward a 0.6 peak. `takePendingSegment` hands
the segment back without decoding it, so the worker acknowledges a commit
before the decode, which is quadratic in the segment's length and would
otherwise hold the IPC past the parent's request timeout;
`sherpa-recognizer.test.js` guards that order.

### Why TTS copies the generated samples

Electron's V8 memory cage rejects external-backed native typed arrays, so
generation requests `enableExternalBuffer: false`. The engine accepts both
native `Float32Array` and plain array output and copies into a `Float32Array`
before encoding PCM16LE. Playback uses a positive numeric rate from the audio
or engine, then falls back to 24 kHz. The speaker and speed checks still
validate worker inputs at use time.

### Why the worker IPC is parsed on both ends

Node hands a forked process's messages to listeners as `unknown` or
`Serializable`, and neither side checked the fields it read: the worker took
any request fields to the engines, and the client forwarded results and session
events unchanged. `worker-protocol.ts` holds Zod schemas for both directions,
and each side parses where a message arrives. A request with the wrong fields
is answered `Malformed dictation worker request: <type>` on the same error path
as an unknown type, which keeps its old message. A non-text language counts as
no hint. Append audio is checked before the session lookup, so a bad payload is
refused even for a session that is already gone. On the client, synthesized audio that is not bytes rejects the request,
a sample rate that is not a positive number falls back to 16 kHz, a malformed
committed or transcript payload becomes a session error, a malformed reply to
a pending request rejects that request, because append, commit, clear and close
have no timeout and would otherwise hold the worker open, and any other message
outside the protocol is ignored, as unknown message types were.
`worker-ipc.test.js` pins each case against a stand-in worker and the real
forked one. Advanced serialization and the serialized-buffer fallback for audio
are unchanged.

`worker-process.js` stays JavaScript because it is the fork target run by path:
it installs source resolution before importing `worker-runtime.ts`, and
`scripts/node-source-entries.test.mjs` lists it as an entry.

### Why the downloader declares Node's fetch locally

Node's fetch returns a `node:stream/web.ReadableStream` body, which
`Readable.fromWeb` accepts directly. The configured DOM fetch declaration instead
supplies a DOM stream with an incompatible BYOB reader signature.
`node-fetch.d.ts` describes the Node response body; the downloader's ambient
binding applies that declaration only to its existing global fetch call.
Global fetch overloads would also change the contracts of unrelated consumers
and injected fetch implementations.

Download progress is an optional internal callback supplied by the dictation
service. Its function type replaces the internal `typeof` check. Response status,
missing response bodies, file presence and extraction failures retain their
runtime checks. Tar failures mentioning bzip2 explain the missing executable.
Windows extracts with a 7-Zip binary outside `app.asar`.

### Why platform resolution starts from the wrapper

An isolated dependency layout keeps the platform package beneath
`sherpa-onnx-node`. Resolution tries that wrapper's require first, then this
module's require. The native-library directory is prepended to the platform's
loader path before loading the raw addon. Windows can inherit a differently
cased `PATH` key; reuse that key to avoid ambiguous child-process lookup.

### Why model-language hints are restricted

Unknown Whisper language codes terminate the native process. Cantonese is
enabled only for the large-v3 turbo export; Qwen3-ASR uses language names.
The multi-language Kokoro model supports English and Chinese, with default
speakers 0 and 3 respectively.
