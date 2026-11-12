import { z } from 'zod';

/**
 * The chat width levels the Chat settings page offers.
 *
 * The width reaches the layout through one mechanism: the root custom
 * properties `--chat-column-width` and `--chat-message-column-width`, which
 * `styles/typography.css` reads for `.chat-column`, `.chat-input-column` and
 * `.chat-message-column`.
 */
export const CHAT_WIDTH_LEVELS = ['compact', 'standard', 'wide', 'full'] as const;

export type ChatWidthLevel = (typeof CHAT_WIDTH_LEVELS)[number];

export const chatWidthLevelSchema = z.enum(CHAT_WIDTH_LEVELS);

export const isChatWidthLevel = (value: string): value is ChatWidthLevel =>
  chatWidthLevelSchema.safeParse(value).success;

/** Today's default column width, so an existing layout does not change. */
export const DEFAULT_CHAT_WIDTH: ChatWidthLevel = 'compact';

/**
 * The column width each level gives the chat and the composer. `wide` widens
 * both columns and `full` fills the chat area with both.
 */
export const CHAT_WIDTH_CSS = {
  compact: { column: '48rem', messageColumn: '48rem' },
  standard: { column: '64rem', messageColumn: '64rem' },
  wide: { column: '80rem', messageColumn: '80rem' },
  full: { column: '100%', messageColumn: '100%' },
} satisfies Record<ChatWidthLevel, { column: string; messageColumn: string }>;

/** The document-root surface the width is written to. */
export type ChatWidthRoot = {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
};

const COLUMN_WIDTH_PROPERTY = '--chat-column-width';
const MESSAGE_COLUMN_WIDTH_PROPERTY = '--chat-message-column-width';

/**
 * Write the level onto the document root; returns the undo for effect cleanup.
 *
 * The level is validated here: a store written by a build with more levels can
 * carry one this build does not define (a downgrade, for example), and
 * hydration skips the migrate hook. Anything unknown falls back to the compact
 * default instead of throwing in the shell's effect.
 */
export const applyChatWidth = (
  level: string,
  root: ChatWidthRoot = document.documentElement,
): (() => void) => {
  const widths = CHAT_WIDTH_CSS[isChatWidthLevel(level) ? level : DEFAULT_CHAT_WIDTH];
  root.style.setProperty(COLUMN_WIDTH_PROPERTY, widths.column);
  root.style.setProperty(MESSAGE_COLUMN_WIDTH_PROPERTY, widths.messageColumn);
  return () => {
    root.style.removeProperty(COLUMN_WIDTH_PROPERTY);
    root.style.removeProperty(MESSAGE_COLUMN_WIDTH_PROPERTY);
  };
};

/** The compact transcript column's rem value, the stylesheet's unset default. */
const DEFAULT_MESSAGE_COLUMN_REM = Number.parseFloat(CHAT_WIDTH_CSS[DEFAULT_CHAT_WIDTH].messageColumn);

/**
 * A column length from `CHAT_WIDTH_CSS` in CSS pixels, or `null` when it fills
 * the window (`100%`). A value this build cannot parse falls back to the
 * compact column at the resolved root font size.
 */
export const chatColumnLengthToPx = (value: string, rootFontSizePx: number): number | null => {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return null;
  const match = /^(\d*\.?\d+)(rem|px)$/.exec(trimmed);
  if (!match) return DEFAULT_MESSAGE_COLUMN_REM * rootFontSizePx;
  const amount = Number.parseFloat(match[1]);
  return match[2] === 'rem' ? amount * rootFontSizePx : amount;
};

const resolvedRootFontSizePx = (style: CSSStyleDeclaration): number => {
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
};

/**
 * The transcript column width the layout resolves right now, in CSS pixels, or
 * `null` when it fills the window. Read from the root property
 * `applyChatWidth` writes, so row estimates match what the stylesheet will
 * use; unset (before a level is applied) is the compact column.
 */
export const readChatMessageColumnWidthPx = (): number | null => {
  const root = globalThis.document?.documentElement;
  if (!root) return DEFAULT_MESSAGE_COLUMN_REM * 16;
  const style = getComputedStyle(root);
  const raw = style.getPropertyValue(MESSAGE_COLUMN_WIDTH_PROPERTY);
  return chatColumnLengthToPx(raw || CHAT_WIDTH_CSS[DEFAULT_CHAT_WIDTH].messageColumn, resolvedRootFontSizePx(style));
};

/** What the stylesheet resolves the chat column's side padding from. */
type ChatColumnPaddingInput = {
  /** Width of the column's containing block; its percentage padding resolves against it. */
  parentWidthPx: number;
  /** Viewport width: the stylesheet changes the padding rule at 1024px and uses `vw` below it. */
  viewportWidthPx: number;
  rootFontSizePx: number;
  paddingScale: number;
};

/**
 * The side-padding rules `styles/typography.css` applies to the chat columns.
 * `chatWidth.test.ts` reads that stylesheet and fails when these drift.
 */
export const CHAT_COLUMN_PADDING_RULES = {
  /** Below the stylesheet's viewport switch: clamp(0.75rem, 2.5vw, 1rem). */
  narrow: { minRem: 0.75, preferredVw: 2.5, maxRem: 1 },
  /** At and above the switch: clamp(1rem, 3% of the column, 1.5rem). */
  wide: { minRem: 1, preferredPercent: 3, maxRem: 1.5 },
  mediaMinPx: 1024,
} as const;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * One side's padding in CSS pixels, mirroring `styles/typography.css`:
 * `clamp(0.75rem, 2.5vw, 1rem) * var(--padding-scale, 1)` below 1024px and
 * `clamp(1rem, 3%, 1.5rem) * var(--padding-scale, 1)` above it.
 */
export const chatColumnPaddingPx = (input: ChatColumnPaddingInput): number => {
  const paddingScale = Number.isFinite(input.paddingScale) ? input.paddingScale : 1;
  const { narrow, wide, mediaMinPx } = CHAT_COLUMN_PADDING_RULES;
  if (input.viewportWidthPx >= mediaMinPx) {
    const preferred = input.parentWidthPx * (wide.preferredPercent / 100);
    return clamp(preferred, input.rootFontSizePx * wide.minRem, input.rootFontSizePx * wide.maxRem) * paddingScale;
  }
  const preferred = input.viewportWidthPx * (narrow.preferredVw / 100);
  return clamp(preferred, input.rootFontSizePx * narrow.minRem, input.rootFontSizePx * narrow.maxRem) * paddingScale;
};

/** The resolved side padding the stylesheet gives the chat columns at this width. */
export const readChatColumnPaddingPx = (parentWidthPx: number): number => {
  const root = globalThis.document?.documentElement;
  if (!root) return 16;
  const style = getComputedStyle(root);
  const paddingScale = Number.parseFloat(style.getPropertyValue('--padding-scale'));
  return chatColumnPaddingPx({
    parentWidthPx,
    viewportWidthPx: globalThis.window?.innerWidth ?? parentWidthPx,
    rootFontSizePx: resolvedRootFontSizePx(style),
    paddingScale,
  });
};
