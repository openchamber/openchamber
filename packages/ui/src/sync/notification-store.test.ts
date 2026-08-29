import { beforeEach, describe, expect, test } from 'bun:test';
import {
  appendNotification,
  markSessionUnread,
  markSessionViewed,
  useNotificationStore,
} from './notification-store';

function resetStore() {
  useNotificationStore.setState({
    list: [],
    index: {
      session: { unseenCount: {}, unseenHasError: {} },
      project: { unseenCount: {}, unseenHasError: {} },
    },
  });
}

describe('markSessionUnread', () => {
  beforeEach(() => {
    resetStore();
  });

  test('injects an unseen notification when the session has none', () => {
    markSessionUnread('session-1', '/repo');

    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);
    expect(useNotificationStore.getState().projectUnseenCount('/repo')).toBe(1);
  });

  test('marks unread without an error flag (neutral indicator)', () => {
    markSessionUnread('session-1', '/repo');

    expect(useNotificationStore.getState().sessionHasError('session-1')).toBe(false);
  });

  test('is idempotent when the session is already unread', () => {
    markSessionUnread('session-1', '/repo');
    markSessionUnread('session-1', '/repo');

    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);
  });

  test('does nothing when the session already has real unseen notifications', () => {
    appendNotification({ type: 'turn-complete', session: 'session-1', directory: '/repo', time: Date.now(), viewed: false });
    markSessionUnread('session-1', '/repo');

    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);
  });

  test('works without a directory', () => {
    markSessionUnread('session-1');

    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);
  });
});

describe('markSessionViewed clears a mark-as-unread', () => {
  beforeEach(() => {
    resetStore();
  });

  test('clears the unseen count set by markSessionUnread', () => {
    markSessionUnread('session-1', '/repo');
    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);

    markSessionViewed('session-1');
    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(0);
  });
});
