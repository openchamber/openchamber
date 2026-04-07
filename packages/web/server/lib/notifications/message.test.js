import { describe, expect, it } from 'bun:test';

import { prepareNotificationLastMessage, truncateNotificationText } from './message.js';

describe('notification message helpers', () => {
  it('truncates oversized notification text', () => {
    expect(truncateNotificationText('abcdef', 3)).toBe('abc...');
  });

  it('falls back to original message when summarization fails', async () => {
    const message = '0123456789';
    const summarize = async () => {
      throw new Error('summarization failed');
    };

    const result = await prepareNotificationLastMessage({
      message,
      summarize,
      settings: {
        summarizeLastMessage: true,
        summaryThreshold: 5,
        summaryLength: 3,
        maxLastMessageLength: 4,
      },
    });

    expect(result).toBe('0123...');
  });

  it('falls back to original message when summary is empty', async () => {
    const result = await prepareNotificationLastMessage({
      message: '0123456789',
      summarize: async () => '   ',
      settings: {
        summarizeLastMessage: true,
        summaryThreshold: 5,
        summaryLength: 3,
        maxLastMessageLength: 4,
      },
    });

    expect(result).toBe('0123...');
  });

  it('uses summary when summarization succeeds', async () => {
    const result = await prepareNotificationLastMessage({
      message: '0123456789',
      summarize: async () => 'short summary',
      settings: {
        summarizeLastMessage: true,
        summaryThreshold: 5,
        summaryLength: 3,
        maxLastMessageLength: 100,
      },
    });

    expect(result).toBe('short summary');
  });

  it('normalizes markdown summary to plain text', async () => {
    const result = await prepareNotificationLastMessage({
      message: '0123456789',
      summarize: async () => "**Committed.**\n\n- Commit: `85924b9d`\n- Message: `fix desktop notifications`",
      settings: {
        summarizeLastMessage: true,
        summaryThreshold: 5,
        summaryLength: 80,
        maxLastMessageLength: 200,
      },
    });

    expect(result).toBe('Committed. Commit: 85924b9d Message: fix desktop notifications');
  });
});
