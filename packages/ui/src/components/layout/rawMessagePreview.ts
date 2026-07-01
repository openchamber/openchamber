import type { Part } from '@opencode-ai/sdk/v2';
import type { TimeFormatPreference } from '@/stores/useUIStore';

/**
 * Helpers for the Raw Messages preview row in the context sidebar.
 *
 * Each collapsed entry shows a role label, parts summary (e.g. "bash",
 * "text + todowrite"), I/O token counters (assistant only), a content
 * snippet, an 8-char message id suffix, and a locale-aware timestamp.
 *
 * Note: we surface the **suffix** of the message id (last 8 chars), not the
 * prefix. OpenCode ids share a long common prefix (e.g. `msg_e39e98d…`); the
 * tail is what actually differentiates them.
 *
 * Helpers here are pure and DOM-free so they can be unit tested.
 */

const PREVIEW_ID_LENGTH = 8;

const partRecord = (part: Part): Record<string, unknown> => part as unknown as Record<string, unknown>;

const partTypeOf = (part: Part): string => {
  const value = partRecord(part).type;
  return typeof value === 'string' ? value : '';
};

const partToolOf = (part: Part): string => {
  const value = partRecord(part).tool;
  return typeof value === 'string' ? value : '';
};

const partTextOf = (part: Part): string => {
  const value = partRecord(part).text;
  return typeof value === 'string' ? value : '';
};

const labelForPart = (part: Part): string => {
  const type = partTypeOf(part);
  if (type === 'tool') {
    const tool = partToolOf(part).trim().toLowerCase();
    return tool || 'tool';
  }
  return type || 'unknown';
};

export const derivePartsLabel = (parts: Part[]): string => {
  if (parts.length === 0) return '';
  const seen: string[] = [];
  for (const part of parts) {
    const label = labelForPart(part);
    if (!seen.includes(label)) {
      seen.push(label);
    }
  }
  return seen.join(' + ');
};

/**
 * Returns the trailing `length` characters of a message id. Used because all
 * ids share the same long prefix and only the suffix is distinguishable.
 */
export const truncateMessageId = (id: string, length: number = PREVIEW_ID_LENGTH): string => {
  if (typeof id !== 'string') return '';
  return id.length <= length ? id : id.slice(-length);
};

/**
 * Collapse whitespace runs into single spaces and trim ends. Keeps the
 * snippet on a single line in the preview row; CSS handles truncation
 * with an ellipsis at whatever width the column ends up rendering at.
 *
 * Punctuation, accents, and unicode are preserved — React escapes the
 * value at render time so there is no injection risk, and the row is
 * visually anchored by the bold `user:` prefix anyway.
 */
const collapseWhitespace = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

/**
 * Derive the inline snippet shown after `user:` on a user-row in the
 * Raw Messages preview. Returns the cleaned text of the first non-empty
 * text part, or `<N attachment[s]>` when the message carries no text
 * (e.g. file-only messages). Returns empty string when the message has
 * no parts at all.
 */
export const deriveUserSnippet = (parts: Part[]): string => {
  for (const part of parts) {
    if (partTypeOf(part) === 'text') {
      const cleaned = collapseWhitespace(partTextOf(part));
      if (cleaned.length === 0) continue;
      return cleaned;
    }
  }
  const nonTextCount = parts.filter((part) => partTypeOf(part) !== 'text').length;
  if (nonTextCount === 0) return '';
  return `${nonTextCount} attachment${nonTextCount === 1 ? '' : 's'}`;
};

/**
 * Format the assistant token counters as `<input> / <output>`. Both zero
 * still renders as `0 / 0` so streaming-not-started messages stay visible
 * in the column instead of disappearing.
 */
export const formatAssistantTokens = (
  input: number,
  output: number,
  formatNumber: (value: number) => string,
): string => `${formatNumber(input)} / ${formatNumber(output)}`;

const resolveHour12 = (preference: TimeFormatPreference): boolean | undefined => {
  if (preference === '12h') return true;
  if (preference === '24h') return false;
  return undefined;
};

/**
 * Format a message timestamp for the Raw Messages preview row.
 *
 * Mirrors the original short "MM/DD HH:MM" shape but honors the user's
 * `timeFormatPreference` setting. In 24h mode no AM/PM is rendered.
 */
export const formatMessagePreviewTime = (
  timestamp: number | null,
  preference: TimeFormatPreference,
): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  const hour12 = resolveHour12(preference);
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: hour12 === false ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(hour12 === undefined ? {} : { hour12 }),
  });
};
