import { describe, expect, test } from 'bun:test';

import { getSearchPaginationDecision } from './searchPagination';

describe('getSearchPaginationDecision', () => {
  test('waits for another session request and retries after it settles', () => {
    expect(getSearchPaginationDecision({
      inFlightKey: 'session-a:query',
      retryVersion: 0,
      settledVersion: 0,
      historyLoading: false,
    })).toBe('wait');

    expect(getSearchPaginationDecision({
      inFlightKey: null,
      retryVersion: 1,
      settledVersion: 1,
      historyLoading: false,
    })).toBe('start');
  });

  test('does not start a duplicate request for the same key', () => {
    expect(getSearchPaginationDecision({
      inFlightKey: 'session-a:query',
      retryVersion: 0,
      settledVersion: 0,
      historyLoading: false,
    })).toBe('wait');
  });

  test('waits while the history loader is already working', () => {
    expect(getSearchPaginationDecision({
      inFlightKey: null,
      retryVersion: 0,
      settledVersion: 0,
      historyLoading: true,
    })).toBe('wait');
  });
});
