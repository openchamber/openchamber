# Text Module Documentation

## Purpose
This module provides shared text transformation helpers that are not owned by a single product surface. Today it contains the shared summarization pipeline used by TTS, notifications, and note distillation flows.

## Entrypoints and structure
- `packages/web/server/lib/text/summarization.js`: Shared summarize + sanitize helpers backed by opencode.ai zen API.

## Public exports

### Summarization (summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Shared summarization entrypoint.
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
- `summary`: Final transformed text.
- `summarized`: Boolean indicating whether model summarization succeeded.
- `reason`: Optional failure/skip reason.
- `originalLength`: Optional original text length.
- `summaryLength`: Optional final summary length.

## Notes for contributors
- Keep this module neutral. Do not re-couple it to TTS-specific naming or routing.
- Add new mode semantics here when multiple product surfaces need the same text pipeline.
- Prefer mode-specific prompt and sanitize behavior over creating duplicated summarizers in unrelated modules.
