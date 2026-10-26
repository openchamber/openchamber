# Text Module Documentation

## Purpose
This module provides shared text transformation helpers that are not owned by a single product surface. It previously proxied model-backed summarization through the opencode.ai Zen provider; that provider is no longer available for this use, so summarization now returns local sanitized/distilled fallback text only.

## Entrypoints and structure
- `packages/web/server/lib/text/summarization.js`: Shared summarize stub + sanitize helpers. It performs no external model calls.

## Public exports

### Summarization (summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Retired summarization entrypoint retained as an API-compatible stub. `zenModel` is ignored.
- `sanitizeForTTS(text)`: Sanitizes text for speech output.
- `sanitizeForNotification(text)`: Sanitizes text for compact notification output.
- `sanitizeForNote(text)`: Sanitizes text for short note/distillation output.

## Modes
- `tts`: Speakable summary for TTS flows.
- `notification`: Short plain-text summary for notification bodies.
- `note`: Distilled short project-memory note.

## Response contract

### `summarizeText`
Returns object with:
- `summary`: Local sanitized/distilled fallback text.
- `summarized`: Always `false` while the model provider is unavailable.
- `reason`: Skip reason, usually `Model summarization provider unavailable` for text above threshold.
- `originalLength`: Optional original text length.
- `summaryLength`: Optional final summary length.

## Notes for contributors
- Keep this module neutral. Do not re-couple it to TTS-specific naming or routing.
- Add new mode semantics here when multiple product surfaces need the same text pipeline.
- Prefer mode-specific prompt and sanitize behavior over creating duplicated summarizers in unrelated modules.
