import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { listAuthenticatedProviders, listNoAuthProviders, listSelectableProviders } from './index.js';

// The auth read happens at import time in some paths and lazily in others.
// We mock the auth module to make the tests deterministic regardless of the
// host's real auth.json contents.
const authState = { current: {} };

mock.module('../opencode/auth.js', () => ({
  readAuthFile: () => authState.current,
  writeAuthFile: () => {},
}));

const reloadIndex = async () => {
  // Bust the module cache so the new auth state is picked up on next call.
  // Bun's module cache keys by resolved path; re-importing the index file
  // re-runs its top-level imports, which in turn re-evaluates the mocked
  // auth module above.
  return import(`./index.js?case=${Math.random()}`);
};

beforeEach(() => {
  authState.current = {};
});

describe('listNoAuthProviders', () => {
  it('always includes the opencode provider', async () => {
    const { listNoAuthProviders } = await reloadIndex();
    expect(listNoAuthProviders()).toContain('opencode');
  });

  it('does not depend on auth.json state', async () => {
    authState.current = {
      anthropic: { type: 'api', key: 'sk-x' },
    };
    const { listNoAuthProviders } = await reloadIndex();
    expect(listNoAuthProviders()).toEqual(['opencode']);
  });
});

describe('listSelectableProviders', () => {
  it('returns only the no-auth providers when nothing is authenticated', async () => {
    authState.current = {};
    const { listSelectableProviders } = await reloadIndex();
    expect(listSelectableProviders()).toEqual(['opencode']);
  });

  it('returns the union of authed + no-auth providers', async () => {
    authState.current = {
      anthropic: { type: 'api', key: 'sk-x' },
    };
    const { listSelectableProviders } = await reloadIndex();
    const list = listSelectableProviders();
    expect(list).toContain('opencode');
    expect(list).toContain('anthropic');
    expect(list.length).toBe(2);
  });

  it('deduplicates when an auth entry shadows a no-auth id', async () => {
    authState.current = {
      opencode: { type: 'api', key: 'oc-key' },
    };
    const { listSelectableProviders } = await reloadIndex();
    const list = listSelectableProviders();
    expect(list.filter((id) => id === 'opencode').length).toBe(1);
  });

  it('omits providers with unusable auth entries', async () => {
    authState.current = {
      anthropic: { type: 'api', key: '' },
      openai: { type: 'oauth' },
    };
    const { listSelectableProviders } = await reloadIndex();
    const list = listSelectableProviders();
    expect(list).toContain('opencode');
    expect(list).not.toContain('anthropic');
    expect(list).not.toContain('openai');
  });
});

describe('listAuthenticatedProviders', () => {
  it('still excludes the no-auth opencode provider when no auth entry is present', async () => {
    // The contract: this function remains strict — only usable auth entries
    // are returned. The no-auth "opencode" provider is intentionally
    // excluded here; the picker uses listSelectableProviders to get the union.
    authState.current = {
      anthropic: { type: 'api', key: 'sk-x' },
    };
    const { listAuthenticatedProviders } = await reloadIndex();
    const list = listAuthenticatedProviders();
    expect(list).toContain('anthropic');
    expect(list).not.toContain('opencode');
  });
});
