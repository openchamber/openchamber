import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitLabClient, createGitLabDownloader } from './client.js';

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

  it('refuses redirects so the credential header never leaves the instance', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    await client.Users.showCurrentUser();
    expect(fetch.mock.calls[0][0].redirect).toBe('error');
  });

  it('keeps GitBeaker query and body encoding', async () => {
    const fetch = vi.fn(async () => Response.json({ iid: 1 }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    await client.MergeRequests.create(1, 'feature', 'main', 'Title', { targetProjectId: 2 });
    const request = fetch.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(await request.json()).toMatchObject({ source_branch: 'feature', target_branch: 'main', target_project_id: 2 });
    await client.MergeRequests.all({ projectId: 1, perPage: 5, page: 2, state: 'opened' });
    expect(new URL(fetch.mock.calls[1][0].url).searchParams.get('per_page')).toBe('5');
  });

  it('does not re-send a mutation after a proxy 502', async () => {
    const fetch = vi.fn(async () => new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    await expect(client.MergeRequests.create(1, 'feature', 'main', 'Title')).rejects.toMatchObject({ cause: { response: { status: 502 } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries reads after a transient 502', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
        .mockResolvedValueOnce(response());
      vi.stubGlobal('fetch', fetch);
      const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
      const pending = client.Users.showCurrentUser();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ id: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GitLab file downloads', () => {
  it('follows a storage redirect once, without the credential, keeping the range', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://storage.example.com/file?sig=1' } }))
      .mockResolvedValueOnce(new Response('clip', { status: 206 }));
    const download = createGitLabDownloader({ origin: 'https://gitlab.example.com', token: 'pat-token', fetch });

    const result = await download('projects/2/uploads/abc/demo.mp4', { range: 'bytes=0-3' });

    expect(result.status).toBe(206);
    const [first, second] = fetch.mock.calls.map(([request]) => request);
    expect(first.url).toBe('https://gitlab.example.com/api/v4/projects/2/uploads/abc/demo.mp4');
    expect(first.headers.get('private-token')).toBe('pat-token');
    expect(second.url).toBe('https://storage.example.com/file?sig=1');
    expect(second.headers.get('private-token')).toBeNull();
    expect(second.headers.get('range')).toBe('bytes=0-3');
  });

  it('refuses a redirect to plain HTTP elsewhere', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://storage.example.com/file' } }));
    const download = createGitLabDownloader({ origin: 'https://gitlab.example.com', token: 'oauth-token', tokenType: 'oauth', fetch });

    await expect(download('projects/2/uploads/abc/demo.mp4')).rejects.toThrow('may not be read from');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
