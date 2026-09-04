import { beforeEach, describe, expect, it } from 'bun:test';

import {
  deriveSessionActivity,
  getSessionActivitySnapshot,
  reconcileSessionActivityFromStatus,
  stopGlobalEventWatcher,
} from './sessionActivityWatcher';

const manager = (protocol) => ({
  getApiUrl: () => 'http://opencode.test',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
  getProtocol: () => protocol,
});

describe('session activity watcher', () => {
  beforeEach(() => {
    stopGlobalEventWatcher();
  });

  it('does not turn an omitted V2 active session into idle', async () => {
    let active = {
      'session-kept': { type: 'local' },
      'session-omitted': { type: 'local' },
    };
    const clients = {
      createV2Client: () => ({ session: { active: async () => active } }),
      createLegacyClient: () => {
        throw new Error('legacy client should not be used');
      },
    };

    await reconcileSessionActivityFromStatus(manager('opencode2'), clients);
    active = { 'session-kept': { type: 'local' } };
    await reconcileSessionActivityFromStatus(manager('opencode2'), clients);

    expect(getSessionActivitySnapshot()).toEqual({
      'session-kept': { type: 'busy' },
      'session-omitted': { type: 'busy' },
    });
  });

  it('retires sessions omitted from the authoritative legacy status snapshot', async () => {
    let statuses = {
      'session-kept': { type: 'busy' },
      'session-omitted': { type: 'retry', attempt: 1, message: 'retry', next: 1 },
    };
    const clients = {
      createV2Client: () => {
        throw new Error('V2 client should not be used');
      },
      createLegacyClient: () => ({
        session: {
          status: async () => ({ data: statuses, error: undefined }),
        },
      }),
    };

    await reconcileSessionActivityFromStatus(manager('legacy'), clients);
    statuses = { 'session-kept': { type: 'busy' } };
    await reconcileSessionActivityFromStatus(manager('legacy'), clients);

    expect(getSessionActivitySnapshot()).toEqual({
      'session-kept': { type: 'busy' },
      'session-omitted': { type: 'idle' },
    });
  });

  it('uses terminal V2 execution events as idle proof', () => {
    expect(deriveSessionActivity({
      type: 'session.execution.started',
      data: { sessionID: 'session-1' },
    })).toEqual({ sessionId: 'session-1', phase: 'busy' });

    expect(deriveSessionActivity({
      type: 'session.execution.interrupted',
      data: { sessionID: 'session-1' },
    })).toEqual({ sessionId: 'session-1', phase: 'idle' });
  });
});
