# Notifications Module Documentation

## Purpose
This module provides notification message preparation utilities for the web server runtime, including text truncation and optional message summarization for system notifications.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/message.js`: helper implementation module.
- `packages/web/server/lib/notifications/message.test.js`: unit tests for notification message helpers.

## Public exports

### Notifications API (re-exported from message.js)
- `truncateNotificationText(text, maxLength)`: Truncates text to specified max length, appending `...` if truncated.
- `prepareNotificationLastMessage({ message, settings, summarize })`: Prepares the last message for notification display, with optional summarization support.

## Constants

### Default values
- `DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH`: 250 (default max length for notification text).
- `DEFAULT_NOTIFICATION_SUMMARY_THRESHOLD`: 200 (minimum message length to trigger summarization).
- `DEFAULT_NOTIFICATION_SUMMARY_LENGTH`: 100 (target length for summarized messages).

## Settings object format

The `settings` parameter for `prepareNotificationLastMessage` supports:
- `summarizeLastMessage` (boolean): Whether to enable summarization for long messages.
- `summaryThreshold` (number): Minimum message length to trigger summarization (default: 200).
- `summaryLength` (number): Target length for summarized messages (default: 100).
- `maxLastMessageLength` (number): Maximum length for the final notification text (default: 250).

## Response contracts

### `truncateNotificationText`
- Returns empty string for non-string input.
- Returns original text if under max length.
- Returns `${text.slice(0, maxLength)}...` for truncated text.

### `prepareNotificationLastMessage`
- Returns empty string for empty/null message.
- Returns truncated original message if summarization disabled, message under threshold, or summarization fails.
- Returns truncated summary if summarization succeeds and returns non-empty string.
- Always applies `maxLastMessageLength` truncation to final result.

## Notes for contributors

### Adding new notification helpers
1. Add new helper functions to `packages/web/server/lib/notifications/message.js`.
2. Export functions that are intended for public use.
3. Follow existing patterns for input validation (e.g., type checking for strings).
4. Use `resolvePositiveNumber` for numeric parameters with fallbacks to maintain safe defaults.
5. Add corresponding unit tests in `packages/web/server/lib/notifications/message.test.js`.

### Error handling
- `prepareNotificationLastMessage` catches summarization errors and falls back to original message.
- Invalid numeric parameters default to safe fallback values.
- Non-string inputs are handled gracefully (return empty string).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Unit tests should cover truncation behavior, summarization success/failure, and edge cases (empty strings, invalid inputs).
