import type { Part } from '@opencode-ai/sdk/v2';

/**
 * Inline comment extracted from a message part. Mirrors the shape OpenCode
 * Desktop uses (`metadata.opencodeComment`) so comments are readable across
 * both apps.
 */
export interface PartInlineComment {
  path: string;
  comment: string;
  selection?: { startLine: number; endLine: number };
  preview?: string;
  origin?: 'file' | 'review';
}

type PartWithCommentFields = Part & {
  synthetic?: boolean;
  text?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Read `metadata.opencodeComment` from a part's metadata (OpenChamber and
 * OpenCode Desktop both write this). Returns undefined when absent/malformed.
 */
export function readCommentMetadata(value: unknown): PartInlineComment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const meta = (value as { opencodeComment?: unknown }).opencodeComment;
  if (!meta || typeof meta !== 'object') return undefined;

  const path = (meta as { path?: unknown }).path;
  const comment = (meta as { comment?: unknown }).comment;
  if (typeof path !== 'string' || typeof comment !== 'string') return undefined;

  const rawSelection = (meta as { selection?: unknown }).selection;
  let selection: { startLine: number; endLine: number } | undefined;
  if (rawSelection && typeof rawSelection === 'object') {
    const startLine = Number((rawSelection as { startLine?: unknown }).startLine);
    const endLine = Number((rawSelection as { endLine?: unknown }).endLine);
    if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
      selection = { startLine, endLine };
    }
  }

  const preview = (meta as { preview?: unknown }).preview;
  const origin = (meta as { origin?: unknown }).origin;

  return {
    path,
    comment,
    selection,
    preview: typeof preview === 'string' ? preview : undefined,
    origin: origin === 'review' || origin === 'file' ? origin : undefined,
  };
}

/**
 * Format a comment into OpenCode Desktop's synthetic text format. Matching this
 * exactly lets OpenCode (and OpenChamber) recover the comment by parsing the
 * text when `metadata` doesn't survive a round-trip.
 * Format: `The user made the following comment regarding lines X through Y of path: comment`
 */
export function formatCommentNote(input: {
  path: string;
  startLine?: number;
  endLine?: number;
  comment: string;
}): string {
  const { path, startLine, endLine, comment } = input;
  const range =
    startLine === undefined || endLine === undefined
      ? 'this file'
      : startLine === endLine
        ? `line ${startLine}`
        : `lines ${startLine} through ${endLine}`;
  return `The user made the following comment regarding ${range} of ${path}: ${comment}`;
}

/**
 * Parse OpenCode Desktop's synthetic comment text format, used as a fallback
 * when `metadata` did not survive the server round-trip.
 * Format: `The user made the following comment regarding lines X through Y of path: comment`
 */
export function parseDesktopCommentNote(text: string): PartInlineComment | undefined {
  const match = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  );
  if (!match) return undefined;
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined;
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined;
  return {
    path: match[5],
    comment: match[6],
    selection:
      start !== undefined && end !== undefined
        ? { startLine: start, endLine: end }
        : undefined,
  };
}

/**
 * Parse OpenChamber's own synthetic comment text format, used as a fallback
 * when `metadata` did not survive the server round-trip.
 * Format: ``Comment on `file` lines X-Y[ (side)]:\n```lang\ncode```\n\ncomment``
 */
export function parseOpenChamberCommentNote(text: string): PartInlineComment | undefined {
  const match = text.match(
    /^Comment on `(.+?)` lines (\d+)-(\d+)(?: \((?:original|modified)\))?:\n```[\s\S]*?```\n\n([\s\S]+)$/,
  );
  if (!match) return undefined;
  const startLine = Number(match[2]);
  const endLine = Number(match[3]);
  // Strip the line range suffix the label carries (e.g. `foo.ts:12-18`).
  const path = match[1].replace(/:\d+(-\d+)?$/, '');
  return {
    path,
    comment: match[4],
    selection: Number.isFinite(startLine) && Number.isFinite(endLine)
      ? { startLine, endLine }
      : undefined,
  };
}

/**
 * Resolve the inline comment carried by a part, if any. Tries structured
 * metadata first, then text-format fallbacks (OpenCode Desktop and
 * OpenChamber).
 *
 * We intentionally do NOT require `synthetic` here: the flag is not guaranteed
 * to survive the server round-trip, and the text-format regexes are strict
 * enough (full distinctive prefixes) to avoid matching ordinary messages.
 */
export function getPartInlineComment(part: Part): PartInlineComment | undefined {
  const p = part as PartWithCommentFields;
  if (p.type !== 'text') return undefined;

  const fromMeta = readCommentMetadata(p.metadata);
  if (fromMeta) return fromMeta;

  const text = typeof p.text === 'string' ? p.text : '';
  if (!text) return undefined;

  return parseDesktopCommentNote(text) ?? parseOpenChamberCommentNote(text);
}

/**
 * OpenCode pairs each inline comment with a line-anchored file part
 * (`file://…?start=N&end=M`). When a matching comment card is already shown,
 * that file chip is redundant. Returns the set of file-part `url`s that should
 * be suppressed because an inline comment in the same message covers them.
 */
export function getRedundantCommentFileUrls(parts: Part[]): Set<string> {
  const suppressed = new Set<string>();
  const comments = parts
    .map((part) => getPartInlineComment(part))
    .filter((c): c is PartInlineComment => Boolean(c?.selection));
  if (comments.length === 0) return suppressed;

  for (const part of parts) {
    const p = part as { type?: string; url?: unknown };
    if (p.type !== 'file' || typeof p.url !== 'string') continue;

    const match = p.url.match(/[?&]start=(\d+)&end=(\d+)/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);

    let filePath: string;
    try {
      filePath = decodeURIComponent(p.url.replace(/^file:\/\//, '').split('?')[0]);
    } catch {
      filePath = p.url.replace(/^file:\/\//, '').split('?')[0];
    }
    const normalizedFilePath = filePath.replace(/\\/g, '/');

    const matchesComment = comments.some((comment) => {
      const sel = comment.selection;
      if (!sel || sel.startLine !== start || sel.endLine !== end) return false;
      const commentPath = comment.path.replace(/\\/g, '/');
      // Match the same file: an exact path, or a path/basename that aligns on a
      // segment boundary. A bare endsWith would false-positive across files
      // (e.g. "myconfig.ts" ending with "config.ts").
      return normalizedFilePath === commentPath
        || normalizedFilePath.endsWith(`/${commentPath}`);
    });

    if (matchesComment) {
      suppressed.add(p.url);
    }
  }

  return suppressed;
}
