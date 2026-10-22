import { describe, expect, test } from 'bun:test';

import { disconnectHostGuest, resolveHostAccessToken, startHostGuestAuthorization, toGuestAuthResponse } from './host-session.js';

const hostLinear = { name: 'Linear board', description: 'Issues', host: { provider: 'linear' } };

/** A tracker registry with one tracker; `hostAccess` is its capability, `access` its implementation's. */
const registryWith = ({ hostAccess = true, access } = {}) => {
  const calls = [];
  const implementation = {
    hostAccess: access ?? {
      apiOrigin: 'https://api.linear.app',
      account: async () => ({ connected: true, label: 'Ada' }),
      accessToken: async () => 'linear-token',
      start: async () => { calls.push('start'); return { authorizationUrl: 'https://linear.app/oauth', expiresIn: 600 }; },
      disconnect: async () => { calls.push('disconnect'); },
    },
  };
  return {
    calls,
    registry: {
      descriptor: (id) => (id === 'linear' ? { id, name: 'Linear', capabilities: { hostAccess } } : null),
      implementation: async (id) => (id === 'linear' ? implementation : null),
    },
  };
};

describe('toGuestAuthResponse', () => {
  test('leaves an oauth guest on the stored public slice', async () => {
    const published = await toGuestAuthResponse({
      name: 'GitLab',
      description: 'Issues',
      oauth: {
        authorizeUrl: 'https://gitlab.com/oauth/authorize',
        tokenUrl: 'https://gitlab.com/oauth/token',
        apiOrigin: 'https://gitlab.com',
      },
    }, {
      accessToken: 'tok',
      account: 'ada',
      clientId: 'app-1',
      // Entered for these endpoints, so the card still counts it as a client.
      clientTarget: { apiOrigin: 'https://gitlab.com', authorizeUrl: 'https://gitlab.com/oauth/authorize', tokenUrl: 'https://gitlab.com/oauth/token' },
      settings: { 'project-path': 'group/project' },
    });
    expect(published).toEqual({
      connected: true,
      account: 'ada',
      hasClient: true,
      settings: { 'project-path': 'group/project' },
    });
  });

  test('answers a host guest with its tracker\'s own account', async () => {
    const { registry } = registryWith();
    expect(await toGuestAuthResponse(hostLinear, null, registry)).toMatchObject({ connected: true, account: 'Ada', hasClient: true });
  });
});

describe('host access through the tracker registry', () => {
  test('borrows the tracker\'s token, sign-in and disconnect', async () => {
    const { registry, calls } = registryWith();
    expect(await resolveHostAccessToken(hostLinear, registry)).toBe('linear-token');
    expect(await startHostGuestAuthorization(hostLinear, registry)).toEqual({ authorizationUrl: 'https://linear.app/oauth', expiresIn: 600 });
    expect(await disconnectHostGuest(hostLinear, registry)).toBe(true);
    expect(calls).toEqual(['start', 'disconnect']);
  });

  test('gives nothing for a tracker that is not registered or does not offer host access', async () => {
    const unknown = { ...hostLinear, host: { provider: 'jira' } };
    const { registry } = registryWith();
    expect(await resolveHostAccessToken(unknown, registry)).toBeNull();
    expect(await startHostGuestAuthorization(unknown, registry)).toBeNull();
    expect(await disconnectHostGuest(unknown, registry)).toBe(false);

    const closed = registryWith({ hostAccess: false });
    expect(await resolveHostAccessToken(hostLinear, closed.registry)).toBeNull();
    // Without a registry there is no host sign-in to borrow.
    expect(await resolveHostAccessToken(hostLinear, null)).toBeNull();
  });

  test('a failed sign-in start is a guest auth error', async () => {
    const { registry } = registryWith({
      access: { start: async () => { throw new Error('client id missing'); } },
    });
    await expect(startHostGuestAuthorization(hostLinear, registry)).rejects.toMatchObject({ code: 'HOST_AUTH_FAILED', message: 'client id missing' });
  });
});
