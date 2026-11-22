import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitLabClient, createGitLabDownloader } from './client.js';
import { classifyGitLabFailure } from './network.js';

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

describe('GitLab client request deadlines', () => {
  const stalledFetch = () => vi.fn((request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }));

  it('rejects a read that never answers at the deadline, retrying each attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const fetch = stalledFetch();
      vi.stubGlobal('fetch', fetch);
      const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
      const pending = client.Users.showCurrentUser().catch((error) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(classifyGitLabFailure(error)).toBe('unreachable');
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a mutation that never answers exactly once before the deadline rejects it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const fetch = stalledFetch();
      vi.stubGlobal('fetch', fetch);
      const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
      const pending = client.MergeRequests.create(1, 'feature', 'main', 'Title').catch((error) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(classifyGitLabFailure(error)).toBe('unreachable');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a download that never answers at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const fetch = stalledFetch();
      const download = createGitLabDownloader({ origin: 'https://gitlab.example.com', token: 'pat-token', fetch });
      const pending = download('projects/2/uploads/abc/demo.mp4').catch((error) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(classifyGitLabFailure(error)).toBe('unreachable');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a download promptly when the caller signal aborts', async () => {
    const fetch = stalledFetch();
    const download = createGitLabDownloader({ origin: 'https://gitlab.example.com', token: 'pat-token', fetch });
    const controller = new AbortController();
    const pending = download('projects/2/uploads/abc/demo.mp4', { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(fetch).toHaveBeenCalledTimes(1);
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

describe('GitLab client error body bound', () => {
  it('surfaces a small JSON error message verbatim', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'project not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    await expect(client.Users.showCurrentUser()).rejects.toThrow('project not found');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('truncates a long error body to the excerpt instead of embedding it whole', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(500), { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    const error = await client.Users.showCurrentUser().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message.length).toBe(200);
    expect(error.cause.description.length).toBe(200);
  });

  it('cuts an oversize streamed error body at the cap instead of buffering it whole', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(120);
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 32) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetch = vi.fn(async () => new Response(stream, { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    const error = await client.Users.showCurrentUser().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('GitLab request failed with status 500');
    expect(error.cause.description.length).toBeLessThanOrEqual(200);
    expect(pulled).toBeLessThan(32);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('GitLab client success body cap', () => {
  const CAP = 16 * 1024 * 1024;

  it('refuses an over-cap JSON success body instead of parsing it', async () => {
    const body = `{"data":"${'x'.repeat(CAP)}"}`;
    const fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    const error = await client.Users.showCurrentUser().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('response_too_large');
    expect(error.message).toBe(`GitLab response exceeded ${CAP} bytes`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-cap text success body instead of returning it', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(CAP + 1), { headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    const error = await client.Users.showCurrentUser().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('response_too_large');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-cap blob success body instead of returning it', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(CAP + 1), { headers: { 'content-type': 'application/octet-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    const error = await client.Users.showCurrentUser().catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('response_too_large');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('still parses a success body at exactly the cap', async () => {
    const overhead = '{"data":""}'.length;
    const body = `{"data":"${'x'.repeat(CAP - overhead)}"}`;
    expect(body.length).toBe(CAP);
    const fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const client = createGitLabClient({ origin: 'https://gitlab.example.com', token: 'pat-token' });
    const result = await client.Users.showCurrentUser();
    expect(result.data.length).toBe(CAP - overhead);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
