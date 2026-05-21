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
});
