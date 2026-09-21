import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitLabClient } from './client.js';

afterEach(() => vi.unstubAllGlobals());

const response = () => Response.json({ id: 1, username: 'user' });

describe('GitLab client credentials', () => {
  it('uses a bearer header for OAuth accounts', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'oauth-token', tokenType: 'oauth' });
    await client.Users.showCurrentUser();
    const headers = fetch.mock.calls[0][0].headers;
    expect(headers.get('authorization')).toBe('Bearer oauth-token');
  });

  it('uses a private-token header for PAT and glab accounts', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    await client.Users.showCurrentUser();
    const headers = fetch.mock.calls[0][0].headers;
    expect(headers.get('private-token')).toBe('pat-token');
  });
});
