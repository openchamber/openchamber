# Text Module Documentation

## Purpose
This module provides shared text transformation helpers that are not owned by a single product surface. It previously proxied model-backed summarization through the opencode.ai Zen provider; that provider is no longer available for this use, so summarization now returns local sanitized/distilled fallback text only.

## Entrypoints and structure
- `packages/web/server/lib/text/summarization.ts`: Shared summarize stub + sanitize helpers. It performs no external model calls. Consumers retain `.js` import specifiers.

## Public exports

### Summarization (summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Retired summarization entrypoint retained as an API-compatible stub. `zenModel` is ignored.
- `sanitizeForTTS(text)`: Sanitizes text for speech output.
- Notification sanitization is private and supplies compact notification output.
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

## Type boundaries

The module has no imports, environment reads, file reads or process messages.
`summarizeText` accepts optional or null text, numeric threshold and length limits,
an ignored model name and a string mode. Missing values keep the documented
defaults. Unknown string modes use TTS sanitization. Non-finite length limits
retain the existing mode-specific handling.

The public sanitizers also receive unvalidated HTTP body values from the TTS
route's error handler. Their shared string guard preserves empty output for
non-string input. Private notification sanitization receives a string from
`summarizeText`, so it does not repeat that runtime type check.

The result names its shared shape and leaves length fields absent when text is
missing or under threshold. Splitting a string always produces a first element;
destructuring defaults express that invariant under checked indexed access
without changing clause selection.

The TTS summarize route validates text and mode but forwards threshold and
maxLength without numeric validation. The notification compatibility wrapper
also forwards its untyped targetLength and zenModel arguments. These callers
remain outside this folder's conversion.
