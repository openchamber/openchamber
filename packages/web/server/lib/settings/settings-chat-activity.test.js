import { describe, expect, test } from 'bun:test';
import { sanitizeChatActivitySettings } from './settings-chat-activity.js';

const sanitize = (candidate) => {
  const result = {};
  sanitizeChatActivitySettings(candidate, result);
  return result;
};

describe('chat activity settings', () => {
  test('keeps earlier replies open for the removed Show notes mode unless the user decided', () => {
    expect(sanitize({ activityRenderMode: 'text' })).toEqual({ activityRenderMode: 'grouped', keepEarlierReplies: true });
    expect(sanitize({ activityRenderMode: 'text', keepEarlierReplies: false })).toEqual({ activityRenderMode: 'grouped', keepEarlierReplies: false });
    expect(sanitize({ chatRenderMode: 'sorted', activityRenderMode: 'text' })).toEqual({ activityRenderMode: 'grouped' });
    expect(sanitize({ activityRenderMode: 'summary' })).toEqual({ activityRenderMode: 'summary' });
  });
});
