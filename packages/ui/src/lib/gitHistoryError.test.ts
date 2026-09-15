import { describe, expect, test } from 'bun:test';
import {
  GitHistoryRequestError,
  STALE_GIT_HISTORY_CURSOR_CODE,
  isStaleGitHistoryCursorError,
} from './gitHistoryError';

describe('gitHistoryError', () => {
  test('prefers the structured stale history code before the message fallback', () => {
    const staleError = new GitHistoryRequestError('Conflict', {
      status: 409,
      code: STALE_GIT_HISTORY_CURSOR_CODE,
    });

    expect(isStaleGitHistoryCursorError(staleError)).toBe(true);
    expect(isStaleGitHistoryCursorError(new Error('stale cursor'))).toBe(true);
    expect(isStaleGitHistoryCursorError(new GitHistoryRequestError('Conflict', { status: 409 }))).toBe(false);
    expect(isStaleGitHistoryCursorError(new Error('merge conflict'))).toBe(false);
  });
});
