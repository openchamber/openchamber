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

The recognizer constructs `OfflineRecognizer` without a guard and lets the
runtime report a non-constructor. TTS checks only that `OfflineTts` is a
function before using `new` and `generate`. A declaration for the wrapper
alone cannot make those calls valid for both loader paths. Missing catalog file
roles also reach `path.join` unchanged, so its invalid-argument failure is
part of the existing behavior.

### Why the worker runtime and client remain JavaScript

Node's `Process.on('message')` listener receives `unknown`.
`ChildProcess.on('message')` receives `Serializable`, which also includes scalar
values and arbitrary objects. Neither outside contract establishes the request
or response fields this folder reads. The worker accesses request fields without
validation, and the client forwards response results and event payloads without
validating their shapes.

These listeners would need an owner-provided checked request/response transport
before their values could honestly have a dictation protocol type. Annotating a
listener with that type would assert an unchecked shape. Adding rejection rules
would change existing error and forwarding behavior. The runtime and client keep
their existing IPC boundary, including advanced serialization and the audio
buffer fallback.

In `DictationWorkerClient`, the first unresolved input is
`handleWorkerMessage(message)`. Its response discriminator does not check
`requestId`, `ok`, `result` or `error`. `synthesizeSpeech` then reads the
unchecked result's audio and format; `createSession` forwards its unchecked
sample rate. In `worker-runtime.js`, `handleRequest(message)` reads the
unchecked process message's discriminator and fields before the audio
conversion guard can run. `sendToParent` forwards segment events unchanged.
Node's broad listener declarations accurately describe these inputs.
Narrowing those declarations through augmentation would assert a protocol
that Node does not check; widening them or converting a helper cannot
establish the missing fields. New validation would change the existing
acceptance and failure paths.

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
