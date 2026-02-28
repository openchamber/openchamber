# TTS Module Documentation

## Purpose
This module provides server-side Text-to-Speech services using OpenAI's TTS API, along with text summarization and sanitization utilities for preparing content for speech synthesis.

## Entrypoints and structure
- `packages/web/server/lib/tts/index.js`: Public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/tts/service.js`: TTS service implementation with OpenAI integration.
- `packages/web/server/lib/tts/summarization.js`: Text summarization and sanitization utilities using opencode.ai zen API.

## Public exports

### TTS Service (from service.js)
- `ttsService`: Singleton instance of TTSService class.
- `TTSService`: TTS service class for OpenAI audio generation.
- `TTS_VOICES`: Array of supported OpenAI voice identifiers.

### Summarization (from summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel })`: Summarizes text for TTS output using opencode.ai zen API.
- `sanitizeForTTS(text)`: Sanitizes text by removing markdown, URLs, file paths, and other non-speakable content.

## Constants

### Voice identifiers
- `TTS_VOICES`: Array of supported OpenAI voices: `['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']`.

### Summarization defaults
- `SUMMARIZE_TIMEOUT_MS`: 30000 (30 seconds timeout for zen API requests).

### Default values
- `summarizeText` defaults: `threshold` = 200, `maxLength` = 500, `zenModel` = 'gpt-5-nano'.
- `generateSpeechStream` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.
- `generateSpeechBuffer` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.

## TTSService methods

### `isAvailable()`
Returns boolean indicating whether OpenAI API key is configured (checks environment variable `OPENAI_API_KEY` or OpenCode auth file).

### `generateSpeechStream(options)`
Generates speech and returns as a web stream for direct streaming to clients.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`, `apiKey`.
- Returns: `{ stream: ReadableStream, contentType: 'audio/mpeg' }`.
- Throws: Error if API key not configured or text is empty.

### `generateSpeechBuffer(options)`
Generates speech and returns as Buffer for caching purposes.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`.
- Returns: Buffer containing MP3 audio data.
- Throws: Error if API key not configured or text is empty.

## Response contracts

### `summarizeText`
Returns object with:
- `summary`: Sanitized summary text or original text (if not summarized).
- `summarized`: Boolean indicating if summarization was performed.
- `reason`: Optional string explaining why summarization was skipped (e.g., 'Text under threshold', 'Request timed out').
- `originalLength`: Optional number for original text length.
- `summaryLength`: Optional number for summarized text length.

### `sanitizeForTTS`
Returns sanitized string with markdown, URLs, file paths, and special characters removed.

### `generateSpeechStream`
Returns object with:
- `stream`: ReadableStream of MP3 audio data.
- `contentType`: Always 'audio/mpeg'.

### `generateSpeechBuffer`
Returns Buffer containing MP3 audio data.

## API key resolution
OpenAI API keys are resolved in order:
1. Environment variable `OPENAI_API_KEY`.
2. OpenCode auth file (`auth.openai`, `auth.codex`, or `auth.chatgpt`).
3. Supports both string format (just token) and object format (with `access` or `token` fields).

## Usage in web server
The TTS module is used by `packages/web/server/index.js` for:
- Generating speech streams for client playback.
- Generating speech buffers for caching.
- Summarizing long messages before TTS synthesis.
- Sanitizing text to remove non-speakable content.

The server-side TTS approach bypasses mobile Safari's audio context restrictions by generating audio on the server and streaming to clients.

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
- `summarizeText` catches zen API errors and falls back to original text with `summarized: false`.
- All errors are logged to console with `[TTSService]` or `[Summarize]` prefix.

### API key management
- TTSService caches OpenAI client instance and recreates when API key changes.
- API key changes are detected by comparing with `_lastApiKey` property.
- This allows dynamic API key updates without server restart.

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Test API key resolution with environment variable and auth file.
- Test speech generation with various text lengths and voice options.
- Test summarization behavior above and below threshold.
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
