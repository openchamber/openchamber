import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  CHAT_COLUMN_PADDING_RULES,
  CHAT_WIDTH_CSS,
  DEFAULT_CHAT_WIDTH,
  applyChatWidth,
  chatColumnLengthToPx,
  chatColumnPaddingPx,
  isChatWidthLevel,
  type ChatWidthRoot,
} from './chatWidth';

type FakeRoot = ChatWidthRoot & {
  properties: Map<string, string>;
};

const createRoot = (): FakeRoot => {
  const properties = new Map<string, string>();
  return {
    properties,
    style: {
      setProperty: (name, value) => {
        properties.set(name, value);
      },
      removeProperty: (name) => {
        properties.delete(name);
      },
    },
  };
};

describe('chat width', () => {
  test('defaults to the compact column that matches the old layout', () => {
    expect(DEFAULT_CHAT_WIDTH).toBe('compact');
    expect(CHAT_WIDTH_CSS.compact).toEqual({ column: '48rem', messageColumn: '48rem' });
  });

  test('maps every level onto its column width', () => {
    expect(CHAT_WIDTH_CSS.standard).toEqual({ column: '64rem', messageColumn: '64rem' });
    expect(CHAT_WIDTH_CSS.wide).toEqual({ column: '80rem', messageColumn: '80rem' });
    expect(CHAT_WIDTH_CSS['full-width']).toEqual({ column: '64rem', messageColumn: '100%' });
    expect(CHAT_WIDTH_CSS.full).toEqual({ column: '100%', messageColumn: '100%' });
  });

  test('writes the chosen width, and wide moves both columns together', () => {
    const root = createRoot();
    applyChatWidth('standard', root);
    expect(root.properties.get('--chat-column-width')).toBe('64rem');
    expect(root.properties.get('--chat-message-column-width')).toBe('64rem');

    applyChatWidth('wide', root);
    expect(root.properties.get('--chat-column-width')).toBe('80rem');
    expect(root.properties.get('--chat-message-column-width')).toBe('80rem');

    applyChatWidth('full-width', root);
    expect(root.properties.get('--chat-column-width')).toBe('64rem');
    expect(root.properties.get('--chat-message-column-width')).toBe('100%');

    applyChatWidth('full', root);
    expect(root.properties.get('--chat-column-width')).toBe('100%');
    expect(root.properties.get('--chat-message-column-width')).toBe('100%');
  });

  test('cleanup removes the variables', () => {
    const root = createRoot();
    const undo = applyChatWidth('wide', root);
    undo();
    expect(root.properties.size).toBe(0);
  });

  test('an unknown level falls back to the compact column', () => {
    const root = createRoot();
    applyChatWidth('huge', root);
    expect(root.properties.get('--chat-column-width')).toBe('48rem');
    expect(root.properties.get('--chat-message-column-width')).toBe('48rem');
  });

  test('accepts only the five levels', () => {
    expect(isChatWidthLevel('compact')).toBe(true);
    expect(isChatWidthLevel('wide')).toBe(true);
    expect(isChatWidthLevel('full-width')).toBe(true);
    expect(isChatWidthLevel('full')).toBe(true);
    expect(isChatWidthLevel('huge')).toBe(false);
  });
});

describe('chat column length', () => {
  test('converts rem against the root font size and keeps pixels', () => {
    expect(chatColumnLengthToPx('48rem', 16)).toBe(768);
    expect(chatColumnLengthToPx('56rem', 16)).toBe(896);
    expect(chatColumnLengthToPx('64rem', 20)).toBe(1280);
    expect(chatColumnLengthToPx('64px', 16)).toBe(64);
  });

  test('a percentage fills the window, and an unparseable length is the compact column', () => {
    expect(chatColumnLengthToPx('100%', 16)).toBeNull();
    expect(chatColumnLengthToPx(' 100% ', 16)).toBeNull();
    expect(chatColumnLengthToPx('', 16)).toBe(768);
    expect(chatColumnLengthToPx('calc(100% - 2rem)', 16)).toBe(768);
  });

  test('the unparseable fallback follows the root font size', () => {
    expect(chatColumnLengthToPx('calc(100% - 2rem)', 24)).toBe(1152);
    expect(chatColumnLengthToPx('', 20)).toBe(960);
  });
});

describe('chat column padding', () => {
  test('above 1024px the padding clamps the parent percentage against rem bounds', () => {
    // clamp(1rem, 3% of 1200, 1.5rem) at 16px = clamp(16, 36, 24) = 24.
    expect(chatColumnPaddingPx({ parentWidthPx: 1200, viewportWidthPx: 1600, rootFontSizePx: 16, paddingScale: 1 })).toBe(24);
    // The bounds follow the root font size: clamp(24, 36, 36) at 24px.
    expect(chatColumnPaddingPx({ parentWidthPx: 1200, viewportWidthPx: 1600, rootFontSizePx: 24, paddingScale: 1 })).toBe(36);
    // The percentage is the parent's, not the viewport's: 3% of 800 = 24, not 3% of 1600.
    expect(chatColumnPaddingPx({ parentWidthPx: 800, viewportWidthPx: 1600, rootFontSizePx: 16, paddingScale: 1 })).toBe(24);
    // A parent narrower than 1rem/3% stays at the 1rem floor.
    expect(chatColumnPaddingPx({ parentWidthPx: 400, viewportWidthPx: 1600, rootFontSizePx: 16, paddingScale: 1 })).toBe(16);
  });

  test('below 1024px the padding clamps the vw percentage against rem bounds', () => {
    // clamp(0.75rem, 2.5vw of 800, 1rem) at 16px = clamp(12, 20, 16) = 16.
    expect(chatColumnPaddingPx({ parentWidthPx: 800, viewportWidthPx: 800, rootFontSizePx: 16, paddingScale: 1 })).toBe(16);
    // At 24px the same viewport lands inside the bounds: clamp(18, 20, 24) = 20.
    expect(chatColumnPaddingPx({ parentWidthPx: 800, viewportWidthPx: 800, rootFontSizePx: 24, paddingScale: 1 })).toBe(20);
    // A narrow viewport stays at the 0.75rem floor.
    expect(chatColumnPaddingPx({ parentWidthPx: 400, viewportWidthPx: 400, rootFontSizePx: 16, paddingScale: 1 })).toBe(12);
  });

  test('the padding scale multiplies both rules', () => {
    expect(chatColumnPaddingPx({ parentWidthPx: 1200, viewportWidthPx: 1600, rootFontSizePx: 16, paddingScale: 2 })).toBe(48);
    expect(chatColumnPaddingPx({ parentWidthPx: 800, viewportWidthPx: 800, rootFontSizePx: 16, paddingScale: 2 })).toBe(32);
  });

  test('the stylesheet padding rules still match the constants', () => {
    const css = readFileSync(new URL('../styles/typography.css', import.meta.url), 'utf8');
    const { narrow, wide, mediaMinPx } = CHAT_COLUMN_PADDING_RULES;
    const narrowRule = `clamp(${narrow.minRem}rem, ${narrow.preferredVw}vw, ${narrow.maxRem}rem)`;
    const wideRule = `clamp(${wide.minRem}rem, ${wide.preferredPercent}%, ${wide.maxRem}rem)`;
    const blocksOf = (selector: string) => (
      [...css.matchAll(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, 'g'))].map((match) => match[1])
    );

    for (const selector of ['chat-column', 'chat-input-column', 'chat-message-column', 'chat-card-column']) {
      const blocks = blocksOf(selector);
      expect(blocks.some((block) => block.includes(narrowRule))).toBe(true);
      expect(blocks.some((block) => block.includes(wideRule))).toBe(true);
    }
    expect(css).toContain(`@media (min-width: ${mediaMinPx}px)`);
  });
});
