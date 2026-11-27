# TTS Module Documentation

## Purpose

This module provides server-side Text-to-Speech services using OpenAI's TTS API. The historical shared text summarization endpoint now lives in `packages/web/server/lib/text/` as an API-compatible stub because the previous Zen model provider is unavailable.

## Entrypoints and structure

- `packages/web/server/lib/tts/index.ts`: Public entrypoint loaded lazily by the speech routes. Relative imports keep `.js` specifiers.
- `packages/web/server/lib/tts/routes.ts`: Express route registration for `/api/voice/*`, `/api/tts/*`, and `/api/stt/*` endpoints. `/api/tts/speak` takes an optional JSON `endpointPath`; `/api/stt/transcribe` takes an optional `X-Endpoint-Path` header. Both answer 400 for an invalid path before contacting the upstream server. `POST /api/tts/voices` takes `{ baseURL }` and answers the custom server's voice ids, or a `code` saying why it could not; beside either it carries `keyId` only while a typed `openaiCompatible` key is stored, never an OpenCode provider's. `POST /api/tts/voices/approval` takes `{ baseURL, keyId, keyProvider? }` and answers `{ approval: 'added' | 'kept' | 'refused' }`; it contacts no voice server. With `keyProvider` it approves that provider's current key and nothing else, so a typed key with the same bytes never stands in for it, and it asks OpenCode for that provider's key to name it in the approval; without `keyProvider` it approves only the typed `openaiCompatible` key. `added` and `kept` are answered only when the grant exists. `GET /api/voice/key-providers?baseURL=` answers the OpenCode providers that have a key, as `{ providers: [{ id, name, keyId, matches, approved }] }`: `matches` is only the preselection (the provider's base URL has that address's origin), `approved` is whether the user has approved this provider's current key for that origin, and never a key; it answers 503 when OpenCode cannot be asked, which Settings shows as an error and not as an empty list. `POST /api/tts/speak` and `POST /api/tts/voices` take an optional `keyProvider`, `/api/stt/transcribe` an optional `X-Key-Provider` header, and dictation an optional `openaiCompatible.keyProvider`: the user's choice of provider key (a provider id, `''` for none, absent while they have not chosen).
- `packages/web/server/lib/tts/capability-runtime.ts`: runtime helper for probing local macOS `say` TTS voice capability.
- `packages/web/server/lib/tts/service.ts`: TTS service implementation with OpenAI integration.
- `packages/web/server/lib/text/summarization.js`: Shared text summarization stub and sanitization utilities. It performs no external Zen calls.
- `packages/web/server/lib/tts/stt.ts`: STT proxy for OpenAI-compatible transcription endpoints.
- `packages/web/server/lib/tts/voice-keys.ts`: the API keys typed in Voice settings (`openai`, `openaiCompatible`, `stt`), stored in `voice-keys.json` in the data dir, mode 0600. Beside the keys it holds the origins the stored `openaiCompatible` key may be sent to without a user action, and the `providerApprovals` (`{ provider, origin, entry?, digest }`) that do the same for an OpenCode provider's key, with the random `identitySecret` that keys every `digest`. `GET /api/voice/keys` answers only which are set, plus `openaiCompatibleKeyId`; `PUT /api/voice/keys` sets (string) or removes (null) them, and its `speechServer` query names the server an `openaiCompatible` key is saved for. `/api/tts/speak`, the STT route and dictation fill a request's key from here, so the UI never holds or sends one. A key in a request body still wins: older clients sent theirs that way. Keys earlier builds kept in the browser's localStorage are moved here by the UI on first read (`packages/ui/src/lib/voiceKeysApi.ts`).
- `packages/web/server/lib/tts/provider-keys.ts`: lists eligible OpenCode provider keys and resolves which ones can be sent to a given origin. A voice request skips this lookup when a typed key takes priority, the user chose None, or no provider approval applies to the requested origin. Settings still reads providers so the user can choose and approve one. If the provider list, the stored credentials or the environment connections cannot be read, Settings receives 503 (a failed environment read is not taken as "no connections", since it could hide a second provider at the same origin) and no provider key is sent for speech or transcription, even if a provider was chosen.
- `packages/web/server/lib/tts/keyed-call.ts`: fixed error messages and the check for an echoed OpenCode provider key.
- The server's own `OPENAI_API_KEY` is used only for OpenAI itself, never sent to a custom server URL (`service.js`, `stt.ts`).
- `packages/web/server/lib/tts/base-url.ts`: shared base URL validation and normalization for custom OpenAI-compatible endpoints.
- `packages/web/server/lib/tts/voices.ts`: reads a custom server's voice list from `<base URL>/audio/voices` (`listCustomServerVoices`) and turns the answers of Kokoro-FastAPI, Speaches and LocalAI into voice ids (`parseVoiceList`).
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

Generates speech and returns the whole audio, which the route sends with its length.

- Options: `text` (required), `voice`, `model`, `speed`, `instructions`, `apiKey`, `providerKey`, `baseURL`, `endpointPath`. The server supplies `providerKey` only after it resolves an approved OpenCode key.
- `endpointPath` is only accepted together with a custom `baseURL`; without one the call throws before any request. An empty value leaves the SDK's `/audio/speech` untouched, so default behavior does not pass through the wrapper at all.
- Upstream `/v1/audio/speech` requests always carry `response_format: 'mp3'` (the documented default; strict servers such as OpenRouter reject requests without it). With a custom baseURL the request omits `instructions` because compatible servers do not universally support it.
- Returns `{ buffer: Buffer, contentType: string }`. Calls that send an OpenCode provider key accept only the listed audio types (`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/opus`, `audio/flac`, `audio/aac`, `audio/mp4`, `audio/webm`) and their recognized aliases. The server returns the canonical type without parameters. Other calls keep the upstream header, including `application/octet-stream` and `audio/pcm`. If the header is missing, both paths use `audio/mpeg` because the request asks for MP3.
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

- `buffer`: Buffer with the audio data.
- `contentType`: the server's canonical audio type for an OpenCode provider key, or the upstream type for other calls. If the upstream omits the header, the type is `audio/mpeg`.

### `generateSpeechBuffer`

Returns Buffer containing MP3 audio data.

## Enterprise mode

With enterprise mode on (`../enterprise-mode.js`), speech and transcription stay on this machine: `normalizeCustomOpenAIBaseURL` refuses any non-local host whatever `OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS` or the desktop runtime would allow, `/api/tts/speak` without a custom server (OpenAI's cloud) and `/api/voice/token` answer 403, and `/api/tts/status` reports `available: false, enterpriseMode: true` so Settings can say why. The voice list goes through the same check, so in enterprise mode it is read only from a server on this machine, and a refused host answers 403 with `code: 'enterprise_mode'`. macOS `say` and the local dictation models are unaffected.

## API key resolution

OpenAI API keys are resolved in order:

1. Environment variable `OPENAI_API_KEY`.
2. OpenCode auth file (`auth.openai`, `auth.codex`, or `auth.chatgpt`).
3. Supports both string format (just token) and object format (with `access` or `token` fields).

## Usage in web server

The TTS module is used by `packages/web/server/index.js` for:

- Generating speech for client playback.
- Generating speech buffers for caching.
- Sanitizing text before TTS synthesis. Historical summarization calls now return local fallback text.
- Sanitizing text to remove non-speakable content.

The historical summarization API is shared with notifications and notes, but currently acts as a no-model fallback/stub.

The server-side TTS approach bypasses mobile Safari's audio context restrictions by generating audio on the server and sending it to clients.

## Invariants

- Enterprise mode keeps speech and transcription on this machine: `normalizeCustomOpenAIBaseURL` refuses every non-local host, whatever `OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS` or the desktop runtime allows, because the audio carries conversation content.
- `/api/tts/speak` and `/api/tts/say/speak` answer 415 to any body that is not JSON, before reading it. The STT route needs no such check: its server URL comes in the `X-Base-URL` header and its body must be `audio/*`, and a page on another site can send neither without a CORS preflight, which the server grants only to its own clients.
- `/api/tts/say/speak` runs `say` with `execFile`, never a shell, and puts `--` before the text. Voice and rate reach `say` as plain arguments, and a text starting with `-` is spoken rather than read as an option such as `-o <file>`.
- Speech and transcription requests to a custom server never follow a redirect (`fetchOptions: { redirect: 'manual' }` in `service.js` and `stt.ts`), and the SDK fails a 3xx like any other error status. `base-url.ts` approved only the configured host, and a 307 or 308 would resend the text or audio, with the stored key on a same-origin hop, to a URL nobody checked. Dictation's custom STT server goes through `transcribeAudio`, so it holds there too.
- A custom endpoint path is judged on its decoded segments. The URL parser collapses `%2e%2e` into a parent segment when a pathname is assigned, so an encoded dot segment is rejected before it can walk out of the configured base path.
- The endpoint-path fetch rewrites a string or `URL` input whose pathname ends in the default resource path, and leaves a `Request` untouched: a `Request` carries its own body, which a URL rewrite would drop.
- Every `STOPWORDS` list in `language-detect.js` has the same length, so scores are comparable across languages.
- For Cyrillic text the letter markers decide Ukrainian or Russian; function words only settle text that shows neither marker set, and a tie with no Russian-only letter goes to Ukrainian.
- `X-Speech-Voice` is percent-encoded: HTTP header values must be printable latin1, Node rejects non-latin1 header content, and macOS voice names can be localized (`Milena (Русский (Россия))`).
- The startup `say` capability probe is a promise shared with `/api/tts/say/status`; an early status request awaits that result rather than starting another probe.
- `/api/tts/speak` ignores the historical summarization request fields; the model-backed summarization provider is retired.
- `PUT /api/voice/keys`: a string sets a key, `null` or `''` removes it, and an absent kind stays as it is.
- STT derives the upload filename extension from the MIME type so a Whisper server can infer the codec when the stream header does not say.
- `POST /api/tts/voices` asks only `<normalized base URL>/audio/voices`. The speech endpoint-path override does not apply to it.
- The voice-list request never follows a redirect: the base-URL check approved only the configured host, and the request can carry the stored key. A redirect counts as `redirected` only when its `Location` path ends in `/audio/voices`; any other, or one without a readable `Location`, means no list.
- The voice-list request carries the stored `openaiCompatible` key only to an origin approved for that key, because it can run without a user action, which speech never does. Otherwise, or without a stored key, it sends `Bearer not-required`, the placeholder `service.js` gives the SDK. It takes no key from the request body, and no field in it can approve.
- Approvals are normalized origins in `voice-keys.json`, in the same atomic write as the key they were given for, and the list route takes the key and its approvals from one read of the file. Saving the key leaves only the origin the save named, or none when it named none (older clients, keys moved out of localStorage); removing it clears them; saving another kind changes nothing. A file without approvals, or with damaged ones, approves none.
- An approval names the key by `keyId`, an HMAC of it under a secret made at server start, which `GET` and `PUT /api/voice/keys` and the answers of `POST /api/tts/voices` carry while a key is stored. An id of any other key is `refused`, so a Retry on a device that has not seen a newer key does not approve that one.
- A custom server gets, in this order: a key typed for that kind (a request body key first, then the stored key), then the key of an OpenCode provider, then `Bearer not-required`. A provider key is never used for OpenAI itself.
- A provider's key is read when the request is made (a dictation stream reads it again for every segment), and OpenChamber never stores, returns or logs it. The providers are the ones the running OpenCode reports (`provider.list` through the existing OpenCode connection), so only model providers qualify (a search integration such as Tavily or Exa with a key does not), and inline or launch configuration is included. The key comes from OpenCode's stored credential of the provider's integration (an active `key` credential; OAuth logins are not keys), else the provider's `settings.apiKey` with `{env:NAME}` resolved from the environment the managed OpenCode was launched with (the one OpenCode's own environment connections use, `readLaunchEnvironment()`), not from OpenChamber's own; for an external OpenCode that environment is not known, so a provider whose key is an `{env:NAME}` reference is not offered, instead of sending this machine's variable of that name; else the key of the integration's environment connection. If OpenCode cannot be asked, there is no provider and no provider key. `GET /api/voice/key-providers` carries a provider's id, name and `keyId`, and its `matches` and `approved` for the address asked about, and nothing else of it; the voice answers carry no provider data.
- The literal `public` in the built-in `opencode` provider's `settings.apiKey` is treated as missing. A stored key, an explicit environment reference or a key from an environment connection remains eligible, even if its value is `public`.
- No provider key goes to any origin, the provider's own included, until the user taps the action that names the provider and the origin (Send key). An approval is `{ provider, origin, entry?, digest }` in `voice-keys.json`, made by `POST /api/tts/voices/approval` with the provider's `keyId`; the id of another key, an unknown provider or an unreadable address is `refused`. `entry` is the id of the OpenCode credential entry when the key comes from OpenCode's credential store, and `digest` is an HMAC of the key under `identitySecret` in every case; neither is the key. An approval holds only while the provider's active key has that entry id (or none) and those exact bytes, so switching account, replacing the key (under the same entry id or not), rotating it or reusing a removed provider id asks again. A provider key whose bytes would change in an HTTP header (leading or trailing whitespace, a tab or line break, a character outside printable ASCII) is not eligible: it is not listed and never sent, because the reflection check below compares the key as stored while the server sees it as sent. Only the explicit action approves: a plain Retry of a failed voice list never does. An origin includes scheme and port, so `http://host/v1`, `https://host/v1` and `https://host:8443/v1` are three origins.
- When the user has not chosen (`keyProvider` absent), the one provider with a key whose base URL, as the running OpenCode reports it (`settings.baseURL`), has the voice server's origin is preselected; with none or several nothing is preselected and the user picks one. Preselecting names a provider and sends nothing: its key goes only after that provider's approval for the origin. A provider that OpenCode reports without a base URL (a built-in provider with only a stored key) is never preselected, and can be chosen and approved like any other.
- A call that sends an OpenCode provider key uses fixed speech and transcription errors, such as `Speech failed: the server answered 401`. Error details from the voice server can contain the key, so only the status is logged, and the OpenAI SDK's own logging (`OPENAI_LOG`) is off for that client, since it can print upstream response details before the echo check runs. Typed-key and keyless calls keep the SDK's logging as configured. Speech applies the audio type allowlist. The response is refused if its speech bytes, transcript or decoded voice ids contain the literal key. A transcript must also be a string. A refused transcript never reaches the browser, log or correction pass. The transcribe route logs only the length of an accepted transcript on this path.
- These response checks guard against accidental echoes. A voice server that receives a key is trusted with it. The checks do not catch deliberate encoding or fragments of a key. With Fix misheard words on, an accepted transcript still goes to the selected Small Model for correction. A call with a typed key or no key keeps the existing speech content type and upstream speech and transcription error details. An empty string for `keyProvider` means None, and a value of the wrong type is treated as absent.
- The voice list is bounded: 5 seconds for the whole exchange, 1 MiB of body, the first 1000 unique ids. Only parsed ids leave the route, never upstream text.
- An upstream 400, 404, 405, 410, 422 or 501, or a 2xx in no known form, means the server has no list (`voices: []`). Every other failure answers a `code`: `invalid_base_url` and `remote_disabled` (400), `enterprise_mode` (403), `rejected_key`, `key_not_sent`, `unreachable`, `redirected`, `list_too_large` and `upstream_error` (502). `redirected` and `list_too_large` name a cause the user fixes by correcting the address or typing the voice, so the field shows no Retry for them. `key_not_sent` is a 401 or 403 to a read that left a stored key out, so the UI never calls that key wrong. A body that is not JSON gets 415 before anything else is read. The route never answers 401.
- `normalizeCustomOpenAIBaseURL` errors carry a `code` (`invalid_base_url`, `enterprise_mode`, `remote_disabled`) beside the message.

## Decisions

### Why request fields that are the wrong type count as absent

`routes.ts` parses each request body and the transcription headers with a Zod
schema at the route. A field of the wrong type is treated as missing and takes
the route's default, the way the say route already treated a voice that was
not text. Before, the speech route forwarded any JSON `voice`, `model`, `speed`
and `instructions` to the upstream request, and the summary route passed
`threshold` and `maxLength` on to coercions that disagreed with each other (a
string threshold compared as a number, a string limit was ignored in
notification mode and used by `Math.min` in note mode). Refusing such requests
with 400 was weighed and rejected: no client in this repository sends them,
and the lenient default keeps every request that worked before working.
`URL` and endpoint-path values stay unknown here, because their normalizers
own those checks.

### Why the say route runs `say` without a shell

`/api/tts/say/speak` runs `say` with `execFile` and an argument list. It used
to build one shell command from the request's voice and rate inside double
quotes and a bare word, so a voice holding a quote or a rate holding `;` ran
another command; the text's quote escaping also left literal backslashes in
what was spoken. A test on macOS sends both and checks that no command ran.

### Why speech keeps legacy credential handling

The service's local credential input type includes strings and objects with `access` or `token`, preserving its legacy compatibility checks. `readOpenCodeCredentials` currently projects only API objects with `key` and OAuth objects with `access`; both fit the local input type. Its declaration remains unchanged because it does not return the additional legacy forms. The string predicate still distinguishes a bare credential from an object, and API objects with only `key` still yield no speech credential.

### Why boundary validation stays at use time

Custom URLs and endpoint paths accept unknown HTTP/configuration values and retain their string checks. URL policy reads the current enterprise and runtime environment on every call. Environment flags themselves are strings or absent, and URL hostnames and language helper inputs are internally typed strings, so their redundant type checks are removed. Endpoint control-character detection checks code units 0 through 31 and 127, preserving both raw and decoded-path rejection without a lint suppression.

Voice-key reads retain the storage schema's inferred optional-string fields. Missing, unreadable or malformed files yield an empty object, malformed individual fields become undefined, and patches still use the strict schema. Filesystem and JSON errors retain their code/message inspection. The store uses Node filesystem, OS and path helpers plus Zod; the other runtime dependencies are the enterprise policy reader, lazy OpenAI SDK, fetch/URL/Request globals, and the macOS child-process probe. Speech credentials remain owned by OpenCode auth and text sanitization remains owned by the text module.

### Why source imports keep JavaScript extensions

The server bootstrap registers source resolution before dynamically loading the runtime. Web, Electron desktop, hosted mobile and Capacitor clients use those server routes; VS Code supplies its own unavailable speech responses and imports none of these helpers. Dictation shares URL/path validation, transcription, voice keys and language detection through the same server entry. Installed consumers load emitted JavaScript. `SayVoice` and `SayTtsCapability` belong to the capability module; transcription options belong to the STT module. Dictation intentionally passes explicit undefined optional transcription fields.

### Why the OpenAI SDK loads on first call

The SDK is about 200 modules and only speech and transcription use it. Loading it on the first call keeps server startup light; an eager import would pay that cost for every run.

### Why the endpoint path rewrites only the last segment

A compatible server can copy OpenAI's request body, auth and response while naming the resource differently. Replacing only `/audio/speech` or `/audio/transcriptions` is enough: the origin, base URL prefix, query and every request option stay as they are.

### Why speech takes only JSON

The custom-server route sends the text and the stored `openaiCompatible` key to the host the request names, and the `say` route runs a program on this Mac. A JSON POST from another site needs a CORS preflight, which the server refuses, but the server also parses form posts (`express.urlencoded` in `../server-frame/core-routes.ts`), and any page can send one of those without asking. Both clients of the `say` route, the reader hook and the Settings preview, already send JSON.

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

### Why the server reads the voice list and not the browser

The key stays on the server, `base-url.js` checks the host when the request is made, and local speech servers send no CORS headers a browser would need.

### Why an unknown answer means no list and not an error

There is no standard voices endpoint, and many servers answer any path with a 200 HTML page. A server without a list keeps the plain voice field; only a real failure (unreachable, refused key, bad answer) is reported.

### Why a refused key answers 502 and not 401

Any `/api/*` 401 makes the UI check its own session, and an upstream key problem is not a session problem.

### Why approvals live beside the key and not in the browser

Every device of a server shares one stored key. Approvals kept in each browser outlived a key another device replaced, and the next read sent the new key to the server approved for the old one.

### Why an approval has its own route

The voice list is read in the background. A field in its body that approved would be one client mistake away from approving on open, so the read has no such field and the user's action makes a separate request.

### Why the save names its server in the query

An older server refuses a `PUT /api/voice/keys` body with a field it does not know. A mobile app can be newer than the server it connects to. For both the key save and `GET /api/voice/key-providers`, only the HTTP(S) origin (scheme, host, and port) is sent in the query. This keeps credentials and tokens from the configured address out of request URLs. If the address has no valid HTTP(S) origin, the query parameter is omitted.

### Why a key id and not a counter

It follows the key itself, so it needs no storage, holds for a file an older server or a user rewrote, and says nothing about the key outside this server process. After a restart the first approval from an open page can be refused; the next answer carries the new id.

### Why the voice list is a POST

The request can make the server send the stored key to a host the request names. A JSON POST needs a CORS preflight, and the route refuses any other body with 415, because the server also parses form posts, which a page on another site can send without asking.

### Why the server picks the provider when the user has not chosen

Reading a message aloud, dictation and the Settings preview each build their own request. An automatic choice made in the browser would have to be made again in each of them from the same list. The request carries only what the user chose, and the server applies the rule where it sends the key, so one rule decides for every caller. Settings shows the same rule through `matches` in `GET /api/voice/key-providers`, which the server computes from the same provider list. Storing the automatic choice as a setting was weighed and rejected: it would keep pointing at a provider after the user moved the server address.

### Why a matching origin only preselects

The key of a provider is sent to the voice server only after the user has tapped Send key for that provider and that origin, also when the origin is the provider's own. The first version let a match with the provider's base URL stand for the approval, because the key goes there for chat already. That rests on the base URL being where chat sends this key. OpenCode resolves the endpoint of a chat request from the model as well as the provider, so a provider-level URL can name an endpoint that chat no longer uses, and the list of OpenCode providers does not say which credential chat uses when more than one is configured. Neither the base URL nor the credential can be established from what the provider list returns, so no match is trusted: it only decides which provider the Key choice shows selected. The match is on scheme, host and port. A path is not part of an origin, so a voice server on another path of the same host matches. The base URL is the one the running OpenCode reports, not one parsed from a config file: OpenCode lets `options.baseURL` win over `api` and adds inline and launch configuration and administrator settings, and a local reader would disagree with it.

### Why a provider approval names the key as well as the provider and the origin

The typed key lives in a file that only Settings writes, so its approvals go with it when it changes. A provider's key lives in OpenCode, where Settings → Providers can switch the active account of a provider, and where an entry can keep its id while it holds other key bytes (the credential API takes an id on creation, and an entry removed and imported again can reuse it). A different account or other bytes can have other privileges, so they are not the key the user approved. The approval therefore names the entry id where the key is stored in OpenCode, and in every case a keyed digest (HMAC-SHA256 under a random secret kept in `voice-keys.json`, mode 0600) of the key bytes. Neither is secret enough to matter alone: the digest cannot be turned back into the key, and the file holds no key. Rotating the key of the same account in place asks again, which is the safe side. The `keyId` keeps its job: an approval made from an open page names the key the page read, so a key swapped in between is `refused`, and Settings then reads the providers again and says the key changed. Retry of a failed voice list reads the providers again too, without approving, so a key that changed while the page stayed open shows Send key again.

### Why the choice is a provider id with three states

`undefined` (not chosen, the server picks by address), `''` (none) and an id are three decisions. Reading `''` as not chosen would turn a user's None into an automatic choice. The id of a provider that no longer has a key sends no key, and Settings shows it as unavailable.

### Why LocalAI's list is not narrowed to the configured model

Speaches mixes the voices of all its models the same way and has no model field, and the Custom… item covers a mismatch. If narrowing comes back, LocalAI takes `?model=` on the same path.

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
- Verify `generateSpeechStream` and `generateSpeechBuffer` produce valid MP3 audio.

## Verification notes

### Manual verification

1. Configure OpenAI API key via environment variable or OpenCode settings.
2. Test `ttsService.isAvailable()` returns true.
3. Call `ttsService.generateSpeechStream({ text: 'Hello world' })` and verify a buffer and content type are returned.
4. Call `ttsService.generateSpeechBuffer({ text: 'Hello world' })` and verify Buffer is returned.
5. Test `summarizeText` with text above and below threshold.
6. Test `sanitizeForTTS` with markdown, URLs, and code blocks.

### API endpoint verification

1. Start web server and access TTS endpoint via client.
2. Verify audio plays correctly in browser.
3. Test on mobile Safari to verify bypass of audio context restrictions.
4. Test with long messages to verify summarization is triggered.
