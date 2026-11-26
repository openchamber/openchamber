import { describe, expect, it } from 'vitest';

import { markdownToPlainText, PLAIN_TEXT_SOURCE_CHARS } from '@openchamber/ui/lib/markdownText';

import { prepareNotificationLastMessage } from '../server/lib/notifications/message.js';
import { NOTIFICATION_SOURCE_CHARS, notificationPlainText } from '../server/lib/notifications/plainText.js';

// The server cannot import UI sources (server-program-boundary.mjs), so its
// projection is a mirror. This test is the ratchet that keeps the mirror true.
const CASES = [
  'Renamed `user_id` to session_id, kept 2 * 3 * 4, and _really_ fixed *it*.',
  '**Committed.**\n\n- Commit: `85924b9d`\n- Message: `fix desktop notifications`',
  'Match **/*.ts and `run_task_x` before GRPC_METHOD_NAME_CONSTANT.',
  '```ts\nconst snake_case = __init__;\n```\nthen `a_b` stays',
  '~~~\nraw_underscore\n~~~',
  '**Key: *reason* here** and *a **b** c*',
  '* first step\n* second step\n1. ordered\n> quoted',
  '    - indented code item',
  '* * *',
  'see [the_text](https://example.com/a_b_c) and ![alt_text](img_x.png)',
  'literal \uE0000\uE000 sentinel',
  '``a`b`` and `<!-- keep -->`',
];

const TOKENS = [
  'word', '**bold**', '*em*', '_em_', '__strong__', '`code_span`', 'snake_case', '2*3*4',
  '**/*.ts', '[link_text](https://example.com/x_y)', '- item', '* item', '1. item', '> quote',
  '# heading', '```', '~~~', '<!-- c -->', 'a_b', '\uE000', '\n', '\n\n', ' ', '***',
];

const seededStrings = (count: number): string[] => {
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 0x80000000;
    return seed / 0x80000000;
  };
  return Array.from({ length: count }, () => {
    const parts = Array.from({ length: 1 + Math.floor(next() * 12) }, () => TOKENS[Math.floor(next() * TOKENS.length)]);
    return parts.join(next() > 0.5 ? ' ' : '');
  });
};

describe('notification plain text mirrors the shared markdown projection', () => {
  it('agrees on fixed markdown cases', () => {
    for (const input of CASES) {
      expect(notificationPlainText(input)).toBe(markdownToPlainText(input, { code: 'drop' }));
    }
  });

  it('agrees on generated markdown mixes', () => {
    for (const input of seededStrings(300)) {
      expect(notificationPlainText(input)).toBe(markdownToPlainText(input, { code: 'drop' }));
    }
  });

  it('keeps both source bounds equal and applies the same cut', async () => {
    expect(NOTIFICATION_SOURCE_CHARS).toBe(PLAIN_TEXT_SOURCE_CHARS);

    const message = `${'x'.repeat(PLAIN_TEXT_SOURCE_CHARS)} tail_marker`;
    const prepared = await prepareNotificationLastMessage({ message, settings: { maxLastMessageLength: 100_000 } });

    expect(prepared).toBe(markdownToPlainText(message.slice(0, PLAIN_TEXT_SOURCE_CHARS), { code: 'drop' }));
    expect(prepared).not.toContain('tail_marker');
  });

  it('bounds the work on an oversized message', async () => {
    const started = performance.now();
    const result = await prepareNotificationLastMessage({
      message: '`'.repeat(1800) + 'a' + '`'.repeat(1100) + 'a' + '`'.repeat(900),
      settings: {},
    });

    expect(result.length).toBeLessThanOrEqual(253);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
