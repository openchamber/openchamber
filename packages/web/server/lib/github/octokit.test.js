import { describe, expect, test } from 'bun:test';

// Token selection in getOctokitOrNull is pure (selectTokenForHost): the stored
// OAuth token is always a github.com credential (the device flow is hardcoded
// to github.com), so it must never reach an enterprise API root. An enterprise
// host only ever gets its own host-pinned gh CLI token.

const { selectTokenForHost } = await import('./octokit.js');

const OAuth = 'github-com-oauth-token';

describe('selectTokenForHost token selection', () => {
  test('github.com keeps the stored OAuth fallback', () => {
    // No gh token, but a stored github.com OAuth token is valid for github.com.
    expect(selectTokenForHost('github.com', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: true,
    })).toBe(OAuth);
    expect(selectTokenForHost(undefined, {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: false,
    })).toBe(OAuth);
  });

  test('a GHE host with no gh token gets NO token, never the stored OAuth token', () => {
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: true,
    })).toBeNull();
    // gh CLI disabled is not a workaround — still no stored OAuth leak.
    expect(selectTokenForHost('github.example.com', {
      ghToken: null,
      storedToken: OAuth,
      ghCliActive: false,
    })).toBeNull();
  });

  test('a GHE host uses its own host-pinned gh token when present', () => {
    expect(selectTokenForHost('github.example.com', {
      ghToken: 'ghe-token',
      storedToken: OAuth,
      ghCliActive: true,
    })).toBe('ghe-token');
  });
});
