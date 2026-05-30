import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

describe('useUIStore – pendingSessionRenameId', () => {
  beforeEach(() => {
    useUIStore.setState({ pendingSessionRenameId: null });
  });

  test('defaults to null', () => {
    expect(useUIStore.getState().pendingSessionRenameId).toBeNull();
  });

  test('setPendingSessionRenameId sets a session id', () => {
    useUIStore.getState().setPendingSessionRenameId('ses_abc123');
    expect(useUIStore.getState().pendingSessionRenameId).toBe('ses_abc123');
  });

  test('setPendingSessionRenameId can be cleared back to null', () => {
    useUIStore.getState().setPendingSessionRenameId('ses_abc123');
    useUIStore.getState().setPendingSessionRenameId(null);
    expect(useUIStore.getState().pendingSessionRenameId).toBeNull();
  });
});
