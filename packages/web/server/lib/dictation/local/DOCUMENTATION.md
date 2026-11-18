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

### Why native loading remains JavaScript

`sherpa-onnx-node` 1.13.8 has JavaScript and JSDoc but no declaration entry.
The fallback loads a raw `.node` addon, whose exports are not checked by the
loader. A typed conversion could only return `unknown`, which the server's lint
gate rejects for public results. Declaring constructors and their results would
promise shapes that this boundary does not establish. The loader, recognizer and
TTS implementations remain JavaScript at that boundary.
The worker runtime and client retain the existing unchecked IPC contract rather
than adding validation or asserting request and response shapes.

### Why the downloader remains JavaScript

The configured DOM type of `fetch().body` and Node's `Readable.fromWeb` stream
type disagree about BYOB buffers backed by `SharedArrayBuffer`. Changing shared
types, asserting compatibility or replacing the stream conversion is outside
this behavior-preserving conversion.

### Why platform resolution starts from the wrapper

An isolated dependency layout keeps the platform package beneath
`sherpa-onnx-node`. Resolution tries that wrapper's require first, then this
module's require. The native-library directory is prepended to the platform's
loader path before loading the raw addon.

### Why model-language hints are restricted

Unknown Whisper language codes terminate the native process. Cantonese is
enabled only for the large-v3 turbo export; Qwen3-ASR uses language names.
The multi-language Kokoro model supports English and Chinese, with default
speakers 0 and 3 respectively.
