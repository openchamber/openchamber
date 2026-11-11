import { beforeEach, describe, expect, test } from 'bun:test';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { Session } from '@/lib/opencode/model';
import type { SessionPatch, SyncEvent } from '@/lib/opencode/events';
import { applySessionEventsToGlobalSessions } from './session-event-router';

const session = (id: string, directory: string): Session => ({
  id, directory, projectID: 'external', title: id, time: { created: 1, updated: 1 },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const patched = (sessionID: string, patch: SessionPatch): SyncEvent => ({ type: 'session.patched', properties: { sessionID, patch } });

beforeEach(() => {
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], entityById: new Map(), hasLoaded: true });
});

describe('session event router', () => {
  test('a usage-only patch reaches the global list', () => {
    useGlobalSessionsStore.getState().upsertSession(session('ses-usage', '/kept'));
    applySessionEventsToGlobalSessions([
      patched('ses-usage', { cost: 5 }),
      patched('ses-usage', { tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }),
      { type: 'session.idle', properties: { sessionID: 'ses-usage' } },
    ]);
    const stored = useGlobalSessionsStore.getState().entityById.get('ses-usage');
    expect(stored?.cost).toBe(5);
    expect(stored?.tokens?.input).toBe(1);
  });

  test('usage patches that advance the updated timestamp survive their coalesced flush', () => {
    useGlobalSessionsStore.getState().upsertSession(session('ses-stream', '/kept'));
    applySessionEventsToGlobalSessions([
      patched('ses-stream', { cost: 5, time: { updated: 2 } }),
      patched('ses-stream', { tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, time: { updated: 3 } }),
      { type: 'session.idle', properties: { sessionID: 'ses-stream' } },
    ]);
    const stored = useGlobalSessionsStore.getState().entityById.get('ses-stream');
    expect(stored?.cost).toBe(5);
    expect(stored?.tokens?.input).toBe(1);
  });

  test('a structural patch publishes the usage a deferred update carried', () => {
    useGlobalSessionsStore.getState().upsertSession(session('ses-title', '/kept'));
    applySessionEventsToGlobalSessions([
      patched('ses-title', { cost: 5, time: { updated: 2 } }),
      patched('ses-title', { title: 'renamed', time: { updated: 3 } }),
    ]);
    const stored = useGlobalSessionsStore.getState().entityById.get('ses-title');
    expect(stored?.title).toBe('renamed');
    expect(stored?.cost).toBe(5);
  });
});
