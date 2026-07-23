/**
 * Shared verbosity model for the Discord ↔ OpenCode bridge.
 *
 * Three levels control how much of an OpenCode turn is mirrored back into the
 * messenger surface:
 *
 *   - `quiet`   — only the assistant's final text. Reasoning markers and tool
 *                 activity are suppressed entirely.
 *   - `normal`  — compact activity feed (the default): one short line per tool
 *                 run (name + summary, errors inline) and a `thinking…` process
 *                 marker — no payloads, no reasoning text.
 *   - `verbose` — everything, formatted for readability: commands and outputs
 *                 in fenced blocks, edits as diffs, reasoning as quoted text.
 *
 * Both the OpenChamber settings UI and the in-chat `/verbosity` command write to
 * the same store, so the level can be changed from either side.
 */

export const VERBOSITY_LEVELS = ['quiet', 'normal', 'verbose'];

export const DEFAULT_VERBOSITY = 'normal';

const VERBOSITY_ALIASES = new Map([
  ['quiet', 'quiet'],
  ['silent', 'quiet'],
  ['low', 'quiet'],
  ['min', 'quiet'],
  ['minimal', 'quiet'],
  ['off', 'quiet'],
  ['normal', 'normal'],
  ['default', 'normal'],
  ['medium', 'normal'],
  ['standard', 'normal'],
  ['std', 'normal'],
  ['verbose', 'verbose'],
  ['high', 'verbose'],
  ['max', 'verbose'],
  ['maximum', 'verbose'],
  ['full', 'verbose'],
  ['all', 'verbose'],
  ['debug', 'verbose'],
]);

/**
 * Map a free-text level (from the UI or a `/verbosity` command) to one of the
 * canonical levels. Returns `null` for unrecognised input so callers can show a
 * helpful error instead of silently picking a default.
 */
export function parseVerbosityLevel(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return VERBOSITY_ALIASES.get(normalized) ?? null;
}

/** Coerce any value to a valid level, falling back to `normal`. */
export function normalizeVerbosity(value) {
  return VERBOSITY_LEVELS.includes(value) ? value : DEFAULT_VERBOSITY;
}
