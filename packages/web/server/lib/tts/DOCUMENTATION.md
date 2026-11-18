# TTS Module Documentation

## Purpose
This module provides server-side Text-to-Speech services using OpenAI's TTS API. The historical shared text summarization endpoint now lives in `packages/web/server/lib/text/` as an API-compatible stub because the previous Zen model provider is unavailable.

## Entrypoints and structure
- `packages/web/server/lib/tts/index.ts`: Public entrypoint loaded lazily by the speech routes. Relative imports keep `.js` specifiers.
- `packages/web/server/lib/tts/routes.js`: Express route registration for `/api/voice/*`, `/api/tts/*`, and `/api/stt/*` endpoints. `/api/tts/speak` takes an optional JSON `endpointPath`; `/api/stt/transcribe` takes an optional `X-Endpoint-Path` header. Both answer 400 for an invalid path before contacting the upstream server.
- `packages/web/server/lib/tts/capability-runtime.ts`: runtime helper for probing local macOS `say` TTS voice capability.
- `packages/web/server/lib/tts/service.js`: TTS service implementation with OpenAI integration.
- `packages/web/server/lib/text/summarization.js`: Shared text summarization stub and sanitization utilities. It performs no external Zen calls.
- `packages/web/server/lib/tts/stt.ts`: STT proxy for OpenAI-compatible transcription endpoints.
- `packages/web/server/lib/tts/voice-keys.ts`: the API keys typed in Voice settings (`openai`, `openaiCompatible`, `stt`), stored in `voice-keys.json` in the data dir, mode 0600. `GET /api/voice/keys` answers only which are set; `PUT /api/voice/keys` sets (string) or removes (null) them. `/api/tts/speak`, the STT route and dictation fill a request's key from here, so the UI never holds or sends one. A key in a request body still wins: older clients sent theirs that way. Keys earlier builds kept in the browser's localStorage are moved here by the UI on first read (`packages/ui/src/lib/voiceKeysApi.ts`).
- The server's own `OPENAI_API_KEY` is used only for OpenAI itself, never sent to a custom server URL (`service.js`, `stt.js`).
- `packages/web/server/lib/tts/base-url.ts`: shared base URL validation and normalization for custom OpenAI-compatible endpoints.
- `packages/web/server/lib/tts/endpoint-path.ts`: validation and request rewriting for a custom resource path. `normalizeEndpointPath` turns a user string into `/resource/path` or `{ error }`; `createEndpointPathFetch` wraps a fetch implementation and replaces only the OpenAI SDK's fixed last path segment (`/audio/speech`, `/audio/transcriptions`), keeping the origin, base URL prefix, query and every request option. A server that copies the OpenAI request body, auth and response but names the resource differently needs exactly this.
- `packages/web/server/lib/tts/language-detect.ts`: dependency-free language detection for voice selection (`detectTextLanguage`, `pickVoiceForLanguage`, `languageOfLocale`). Used by the macOS `say` route (`language: 'auto'` switches to an installed voice whose locale matches the text; the response carries percent-encoded `X-Speech-Voice` and `X-Speech-Language`) and by the dictation module's local TTS model choice.

## Public exports

### TTS Service (from service.js)
- `ttsService`: Singleton instance of TTSService class.
- `TTSService`: TTS service class for OpenAI audio generation.
- `TTS_VOICES`: Array of supported OpenAI voice identifiers.

### Shared text summarization (re-exported from ../text/summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Retired shared text summarizer retained as a stub. TTS uses `mode: 'tts'`; `zenModel` is ignored.
- `sanitizeForTTS(text)`: Sanitizes text by removing markdown, URLs, file paths, and other non-speakable content.
- `sanitizeForNote(text)`: Re-exported for note-mode callers that still import through the TTS surface.

### Endpoint path (from endpoint-path.js)
- `normalizeEndpointPath(value)`: `{ value }` with a leading slash, `{ value: undefined }` for an empty value (no override), or `{ error }` for an absolute URL, protocol-relative URL, query or fragment, backslash, whitespace, control character, dot segment, bare `/`, or a value over 1024 characters.
- `createEndpointPathFetch({ endpointPath, defaultPath, baseFetch })`: fetch wrapper that rewrites only requests whose pathname ends with `defaultPath`.

### Capability runtime (capability-runtime.js)
- `detectSayTtsCapability(processLike)`: probes local `say -v "?"` support and returns `{ available, voices, reason }`.

## Constants

### Voice identifiers
- `TTS_VOICES`: Array of supported OpenAI voices: `['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']`.

### Summarization defaults
- No model request timeout is used; the summarization provider is disabled.

### Default values
- `summarizeText` defaults: `threshold` = 200, `maxLength` = 500, `mode` = 'tts'. `zenModel` is ignored.
- `generateSpeechStream` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.
- `generateSpeechBuffer` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.

## TTSService methods

### `isAvailable()`
Returns boolean indicating whether OpenAI API key is configured (checks environment variable `OPENAI_API_KEY` or OpenCode auth file).

### `generateSpeechStream(options)`
Generates speech and returns as a web stream for direct streaming to clients.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`, `apiKey`, `baseURL`, `endpointPath`.
- `endpointPath` is only accepted together with a custom `baseURL`; without one the call throws before any request. An empty value leaves the SDK's `/audio/speech` untouched, so default behavior does not pass through the wrapper at all.
- Upstream `/v1/audio/speech` requests always carry `response_format: 'mp3'` (the documented default; strict servers such as OpenRouter reject requests without it). With a custom baseURL the request omits `instructions` because compatible servers do not universally support it.
- Returns: `{ stream: ReadableStream, contentType: string }` — `contentType` is the upstream response's `Content-Type` header, falling back to `'audio/mpeg'` when the server omits it.
- Throws: Error if API key not configured or text is empty.

### `generateSpeechBuffer(options)`
Generates speech and returns as Buffer for caching purposes.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`.
- Returns: Buffer containing MP3 audio data.
- Throws: Error if API key not configured or text is empty.

## Response contracts

### `summarizeText`
Returns object with:
- `summary`: Sanitized or locally distilled fallback text.
- `summarized`: Always `false` while the model provider is unavailable.
- `reason`: String explaining why summarization was skipped.
- `originalLength`: Optional number for original text length.
- `summaryLength`: Optional number for summarized text length.

The route-level text summarize API is now `/api/text/summarize`.

### `sanitizeForTTS`
Returns sanitized string with markdown, URLs, file paths, and special characters removed.

### `generateSpeechStream`
Returns object with:
- `stream`: ReadableStream of MP3 audio data.
- `contentType`: the upstream response's `Content-Type` header, falling back to `'audio/mpeg'` when the server omits it.

### `generateSpeechBuffer`
Returns Buffer containing MP3 audio data.

## Enterprise mode
With enterprise mode on (`../enterprise-mode.js`), speech and transcription stay on this machine: `normalizeCustomOpenAIBaseURL` refuses any non-local host whatever `OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS` or the desktop runtime would allow, `/api/tts/speak` without a custom server (OpenAI's cloud) and `/api/voice/token` answer 403, and `/api/tts/status` reports `available: false, enterpriseMode: true` so Settings can say why. macOS `say` and the local dictation models are unaffected.

## API key resolution
OpenAI API keys are resolved in order:
1. Environment variable `OPENAI_API_KEY`.
2. OpenCode auth file (`auth.openai`, `auth.codex`, or `auth.chatgpt`).
3. Supports both string format (just token) and object format (with `access` or `token` fields).

## Usage in web server
The TTS module is used by `packages/web/server/index.js` for:
- Generating speech streams for client playback.
- Generating speech buffers for caching.
- Sanitizing text before TTS synthesis. Historical summarization calls now return local fallback text.
- Sanitizing text to remove non-speakable content.

The historical summarization API is shared with notifications and notes, but currently acts as a no-model fallback/stub.

The server-side TTS approach bypasses mobile Safari's audio context restrictions by generating audio on the server and streaming to clients.

## Invariants

- Enterprise mode keeps speech and transcription on this machine: `normalizeCustomOpenAIBaseURL` refuses every non-local host, whatever `OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS` or the desktop runtime allows, because the audio carries conversation content.
- A custom endpoint path is judged on its decoded segments. The URL parser collapses `%2e%2e` into a parent segment when a pathname is assigned, so an encoded dot segment is rejected before it can walk out of the configured base path.
- The endpoint-path fetch rewrites a string or `URL` input whose pathname ends in the default resource path, and leaves a `Request` untouched: a `Request` carries its own body, which a URL rewrite would drop.
- Every `STOPWORDS` list in `language-detect.js` has the same length, so scores are comparable across languages.
- For Cyrillic text the letter markers decide Ukrainian or Russian; function words only settle text that shows neither marker set, and a tie with no Russian-only letter goes to Ukrainian.
- `X-Speech-Voice` is percent-encoded: HTTP header values must be printable latin1, Node rejects non-latin1 header content, and macOS voice names can be localized (`Milena (Русский (Россия))`).
- The startup `say` capability probe is a promise shared with `/api/tts/say/status`; an early status request awaits that result rather than starting another probe.
- `/api/tts/speak` ignores the historical summarization request fields; the model-backed summarization provider is retired.
- `PUT /api/voice/keys`: a string sets a key, `null` or `''` removes it, and an absent kind stays as it is.
- STT derives the upload filename extension from the MIME type so a Whisper server can infer the codec when the stream header does not say.

## Decisions

### Why two implementations remain JavaScript

`service.js` accepts a string credential or an object with `access` or `token`. The outside boundary is `readOpenCodeCredentials(): Promise<LegacyAuthFile>` in `../opencode/auth.d.ts`: `LegacyAuthEntry` declares only API credentials with `key` and OAuth credentials with `access`. The implementation projects those same two object shapes in `projectCredentialValue`; it never returns a legacy string or token-bearing object. Widening the declaration to include those forms would not describe an additional runtime path in its owner. Removing the legacy branches or reading `key` changes speech behavior, and the legacy credential tests exercise the string and token-bearing forms. Converting the service requires reconciling that compatibility contract beyond a type-only correction.

`routes.js` forwards unchecked JSON `threshold` and `maxLength` values to `../text/summarization.ts`. Its `SummarizeTextOptions.threshold` and `.maxLength` require numbers, while existing requests can supply strings or null and rely on JavaScript coercion. Widening those fields alone cannot type the implementation: `summarizeText` compares `text.length <= threshold`, and `distillNoteFallback` passes `maxLength` to `Math.min`. Both need coercion or narrowing in their owner before they can consume unknown inputs under the strict checker. Explicit coercion would change runtime code outside this folder. The error fallback also forwards unchecked text to `sanitizeForTTS` and `sanitizeForNote`; their existing string guards would permit widening those sanitizer parameters, but that correction alone does not resolve the numeric boundary. Declaring the request fields as numbers or strings would promise validation the route never performs.

### Why boundary validation stays at use time

Custom URLs and endpoint paths accept unknown HTTP/configuration values and retain their string checks. URL policy reads the current enterprise and runtime environment on every call. Environment flags themselves are strings or absent, and URL hostnames and language helper inputs are internally typed strings, so their redundant type checks are removed. Endpoint control-character detection checks code units 0 through 31 and 127, preserving both raw and decoded-path rejection without a lint suppression.

Voice-key reads retain the storage schema's inferred optional-string fields. Missing, unreadable or malformed files yield an empty object, malformed individual fields become undefined, and patches still use the strict schema. Filesystem and JSON errors retain their code/message inspection. The store uses Node filesystem, OS and path helpers plus Zod; the other runtime dependencies are the enterprise policy reader, lazy OpenAI SDK, fetch/URL/Request globals, and the macOS child-process probe. Speech credentials remain owned by OpenCode auth and text sanitization remains owned by the text module.

### Why source imports keep JavaScript extensions

The server bootstrap registers source resolution before dynamically loading the runtime. Web, Electron desktop, hosted mobile and Capacitor clients use those server routes; VS Code supplies its own unavailable speech responses and imports none of these helpers. Dictation shares URL/path validation, transcription, voice keys and language detection through the same server entry. Installed consumers load emitted JavaScript. `SayVoice` and `SayTtsCapability` belong to the capability module; transcription options belong to the STT module. Dictation intentionally passes explicit undefined optional transcription fields.

### Why the OpenAI SDK loads on first call
The SDK is about 200 modules and only speech and transcription use it. Loading it on the first call keeps server startup light; an eager import would pay that cost for every run.

### Why the endpoint path rewrites only the last segment
A compatible server can copy OpenAI's request body, auth and response while naming the resource differently. Replacing only `/audio/speech` or `/audio/transcriptions` is enough: the origin, base URL prefix, query and every request option stay as they are.

### Why language detection is local and dependency free
The writing system decides most cases outright, and Latin-script languages are told apart by function words and characteristic letters. The result is a best effort for voice selection, not a linguistic claim, so an unknown language falls back to English rather than failing.

### Why a kana character settles Japanese
Kana settles Japanese even when Han characters dominate the count; a text with no kana and at least 30% Han is Chinese.

### Why a characteristic letter can outrank stopword counts
A letter that belongs to one Latin-script language is evidence a quoted foreign word cannot cancel: a German text quoting "façade" stays German unless another language clearly dominates the function words.

### Why macOS `say` output is m4a
The route asks `say` for `--data-format=aac`, which writes an m4a file that browsers decode.

### Why `language: 'auto'` keeps the chosen voice when nothing matches
A language with no installed voice still gets read in the chosen voice, with an accent, rather than failing. The voice switches only when an installed voice speaks the detected language.

## Notes for contributors

### Adding new TTS features
1. Add new methods to `packages/web/server/lib/tts/service.js` TTSService class.
2. Export public functions from `packages/web/server/lib/tts/index.js`.
3. Follow existing patterns for API key resolution and error handling.
4. Ensure all text is sanitized before TTS synthesis.
5. Consider adding new voice options to `TTS_VOICES` constant.

### Text sanitization
- Always call `sanitizeForTTS` on text before passing to TTS generation.
- The sanitization removes markdown, code blocks, URLs, file paths, shell commands, and special characters.
- This prevents the TTS from reading out technical formatting that sounds unnatural.

### Error handling
- `generateSpeechStream` and `generateSpeechBuffer` throw descriptive errors for missing API keys or empty text.
- `summarizeText` does not call Zen and returns mode-specific fallback text with `summarized: false`.
- All errors are logged to console with `[TTSService]` or `[Summarize]` prefix.

### API key management
- TTSService caches OpenAI client instance and recreates when API key changes.
- API key changes are detected by comparing with `_lastApiKey` property.
- This allows dynamic API key updates without server restart.

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Test API key resolution with environment variable and auth file.
- Test speech generation with various text lengths and voice options.
- Test summarization stub behavior above and below threshold.
- Test sanitization with markdown, URLs, and code blocks.
- Verify streaming and buffer generation produce valid MP3 audio.

## Verification notes

### Manual verification
1. Configure OpenAI API key via environment variable or OpenCode settings.
2. Test `ttsService.isAvailable()` returns true.
3. Call `ttsService.generateSpeechStream({ text: 'Hello world' })` and verify stream is returned.
4. Call `ttsService.generateSpeechBuffer({ text: 'Hello world' })` and verify Buffer is returned.
5. Test `summarizeText` with text above and below threshold.
6. Test `sanitizeForTTS` with markdown, URLs, and code blocks.

### API endpoint verification
1. Start web server and access TTS endpoint via client.
2. Verify audio plays correctly in browser.
3. Test on mobile Safari to verify bypass of audio context restrictions.
4. Test with long messages to verify summarization is triggered.
