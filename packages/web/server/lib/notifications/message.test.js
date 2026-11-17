import { describe, expect, it } from 'vitest';

import { prepareNotificationLastMessage, truncateNotificationText } from './message.js';

describe('notification message helpers', () => {
  it('truncates oversized notification text', () => {
    expect(truncateNotificationText('abcdef', 3)).toBe('abc...');
  });

  it('ignores retired summarization settings and truncates original message', async () => {
    const result = await prepareNotificationLastMessage({
      message: '0123456789',
      settings: {
        summarizeLastMessage: true,
        summaryThreshold: 5,
        summaryLength: 3,
        maxLastMessageLength: 4,
      },
    });

    expect(result).toBe('0123...');
  });

  it('normalizes markdown message to plain text', async () => {
    const result = await prepareNotificationLastMessage({
      message: "**Committed.**\n\n- Commit: `85924b9d`\n- Message: `fix desktop notifications`",
      settings: {
        maxLastMessageLength: 200,
      },
    });

    expect(result).toBe('Committed. Commit: 85924b9d Message: fix desktop notifications');
  });

  it('keeps underscores and stars inside words and math', async () => {
    const result = await prepareNotificationLastMessage({
      message: 'Renamed `user_id` to session_id, kept 2 * 3 * 4, and _really_ fixed *it*.',
      settings: {},
    });

    expect(result).toBe('Renamed user_id to session_id, kept 2 * 3 * 4, and really fixed it.');
  });
});

describe('truncateNotificationText surrogate-pair boundary (#1922)', () => {
  const EMOJI = '\u{1F600}';

  it('never ends the cut on a lone high surrogate', () => {
    const out = truncateNotificationText(`${'a'.repeat(249)}${EMOJI}${'b'.repeat(200)}`, 250);
    expect(out).toBe(`${'a'.repeat(249)}...`);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('keeps a pair that fits whole inside the limit', () => {
    const out = truncateNotificationText(`${'a'.repeat(248)}${EMOJI}${'b'.repeat(200)}`, 250);
    expect(out).toBe(`${'a'.repeat(248)}${EMOJI}...`);
  });

  it('holds through prepareNotificationLastMessage at the default-shaped limit', async () => {
    const out = await prepareNotificationLastMessage({
      message: `${'a'.repeat(249)}${EMOJI}${'b'.repeat(200)}`,
      settings: { maxLastMessageLength: 250 },
    });
    expect(out).toBe(`${'a'.repeat(249)}...`);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });
});
