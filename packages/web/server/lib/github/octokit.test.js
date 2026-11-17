import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let octokitModule;

beforeEach(async () => {
  vi.resetModules();
  octokitModule = await import('./octokit.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonBodyOfSize = (size, fill = 'x') => `{"login":"${fill.repeat(size - 12)}"}`;

const headerValue = (headers, name) => new Headers(headers || {}).get(name) ?? undefined;

const streamedResponse = (body, etag) => {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json', etag },
  });
};

// The same body delivered in many chunks with no Content-Length at all
// (chunked transfer): the case where a single arrayBuffer() read used to
// materialize the whole response before the cache cap was checked.
const chunkedResponse = (body, etag, extraHeaders = {}) => {
  const bytes = new TextEncoder().encode(body);
  const chunkSize = 256 * 1024;
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json', etag, ...extraHeaders },
  });
};

describe('Octokit ETag cache byte bounds (#848)', () => {
  it('returns an oversize streamed response whole but does not retain or replay it', async () => {
    const { createOctokit } = octokitModule;
    // ETAG_CACHE_MAX_ENTRY_BYTES = 2 MiB (named constant in octokit.js)
    const oversize = jsonBodyOfSize(2 * 1024 * 1024 + 1024);
    let calls = 0;
    let secondHadIfNoneMatch = false;
    vi.stubGlobal('fetch', async (url, options = {}) => {
      calls += 1;
      if (calls === 1) return streamedResponse(oversize, '"big-1"');
      secondHadIfNoneMatch = headerValue(options.headers, 'if-none-match') !== undefined;
      if (secondHadIfNoneMatch) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ login: 'fresh' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"big-2"' },
      });
    });

    const octokit = createOctokit('token-oversize-stream', 'account-oversize-stream');
    const first = await octokit.rest.users.getAuthenticated();
    expect(first.data.login.length).toBe(oversize.length - 12);

    const second = await octokit.rest.users.getAuthenticated();
    expect(calls).toBe(2);
    expect(secondHadIfNoneMatch).toBe(false);
    expect(second.data.login).toBe('fresh');
  });

  it('passes a response with an oversize declared content-length through uncached', async () => {
    const { createOctokit } = octokitModule;
    const oversize = jsonBodyOfSize(2 * 1024 * 1024 + 2048, 'y');
    let calls = 0;
    vi.stubGlobal('fetch', async (url, options = {}) => {
      calls += 1;
      if (headerValue(options.headers, 'if-none-match')) {
        return new Response(null, { status: 304 });
      }
      return new Response(calls === 1 ? oversize : JSON.stringify({ login: 'fresh-declared' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          etag: '"declared-1"',
          'content-length': String(calls === 1 ? oversize.length : 24),
        },
      });
    });

    const octokit = createOctokit('token-oversize-declared', 'account-oversize-declared');
    const first = await octokit.rest.users.getAuthenticated();
    expect(first.data.login.length).toBe(oversize.length - 12);

    const second = await octokit.rest.users.getAuthenticated();
    expect(second.data.login).toBe('fresh-declared');
  });

  it('streams an oversize response with an absent content-length whole but does not retain it', async () => {
    const { createOctokit } = octokitModule;
    const oversize = jsonBodyOfSize(2 * 1024 * 1024 + 1024);
    let calls = 0;
    let secondHadIfNoneMatch = false;
    vi.stubGlobal('fetch', async (url, options = {}) => {
      calls += 1;
      if (calls === 1) return chunkedResponse(oversize, '"chunked-absent-1"');
      secondHadIfNoneMatch = headerValue(options.headers, 'if-none-match') !== undefined;
      if (secondHadIfNoneMatch) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ login: 'fresh-chunked' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"chunked-absent-2"' },
      });
    });

    const octokit = createOctokit('token-chunked-absent', 'account-chunked-absent');
    const first = await octokit.rest.users.getAuthenticated();
    expect(first.data.login.length).toBe(oversize.length - 12);

    const second = await octokit.rest.users.getAuthenticated();
    expect(calls).toBe(2);
    expect(secondHadIfNoneMatch).toBe(false);
    expect(second.data.login).toBe('fresh-chunked');
  });

  it('streams an oversize response with an understated content-length whole but does not retain it', async () => {
    const { createOctokit } = octokitModule;
    const oversize = jsonBodyOfSize(2 * 1024 * 1024 + 1024);
    let calls = 0;
    let secondHadIfNoneMatch = false;
    vi.stubGlobal('fetch', async (url, options = {}) => {
      calls += 1;
      if (calls === 1) {
        // Declared far under the cap; the streamed bytes cross it. The
        // declared length must not truncate or retain the response.
        return chunkedResponse(oversize, '"chunked-understated-1"', { 'content-length': '100' });
      }
      secondHadIfNoneMatch = headerValue(options.headers, 'if-none-match') !== undefined;
      if (secondHadIfNoneMatch) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ login: 'fresh-understated' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"chunked-understated-2"' },
      });
    });

    const octokit = createOctokit('token-chunked-understated', 'account-chunked-understated');
    const first = await octokit.rest.users.getAuthenticated();
    expect(first.data.login.length).toBe(oversize.length - 12);

    const second = await octokit.rest.users.getAuthenticated();
    expect(calls).toBe(2);
    expect(secondHadIfNoneMatch).toBe(false);
    expect(second.data.login).toBe('fresh-understated');
  });

  it('caches a streamed under-cap response with an absent content-length and replays it on 304', async () => {
    const { createOctokit } = octokitModule;
    const small = JSON.stringify({ login: 'streamed-octo' });
    let calls = 0;
    let secondHadIfNoneMatch = false;
    vi.stubGlobal('fetch', async (url, options = {}) => {
      calls += 1;
      if (calls === 1) return chunkedResponse(small, '"chunked-small-1"');
      secondHadIfNoneMatch = headerValue(options.headers, 'if-none-match') !== undefined;
      return new Response(null, { status: 304 });
    });

    const octokit = createOctokit('token-chunked-small', 'account-chunked-small');
    const first = await octokit.rest.users.getAuthenticated();
    const second = await octokit.rest.users.getAuthenticated();
    expect(first.data.login).toBe('streamed-octo');
    expect(calls).toBe(2);
    expect(secondHadIfNoneMatch).toBe(true);
    expect(second.data.login).toBe('streamed-octo');
  });

  it('still caches and replays a small response on 304', async () => {
    const { createOctokit } = octokitModule;
    let calls = 0;
    let secondHadIfNoneMatch = false;
    vi.stubGlobal('fetch', async (url, options = {}) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ login: 'octo' }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"small-1"' },
        });
      }
      secondHadIfNoneMatch = headerValue(options.headers, 'if-none-match') !== undefined;
      return new Response(null, { status: 304 });
    });

    const octokit = createOctokit('token-small', 'account-small');
    const first = await octokit.rest.users.getAuthenticated();
    const second = await octokit.rest.users.getAuthenticated();
    expect(first.data.login).toBe('octo');
    expect(calls).toBe(2);
    expect(secondHadIfNoneMatch).toBe(true);
    expect(second.data.login).toBe('octo');
  });

  it('evicts least-recently-used entries so total retained bytes stay within the total budget', async () => {
    const { createOctokit } = octokitModule;
    // ETAG_CACHE_MAX_ENTRY_BYTES = 2 MiB, ETAG_CACHE_MAX_TOTAL_BYTES = 32 MiB
    const entrySize = (32 * 1024 * 1024) / 16;
    expect(entrySize).toBeLessThanOrEqual(2 * 1024 * 1024);
    const entryCount = (32 * 1024 * 1024) / entrySize + 1; // one past the budget
    const seenIfNoneMatch = new Map();
    vi.stubGlobal('fetch', async (url, options = {}) => {
      const authorization = headerValue(options.headers, 'authorization') || '';
      const token = authorization.replace(/^token\s+/i, '');
      const hadIfNoneMatch = headerValue(options.headers, 'if-none-match') !== undefined;
      seenIfNoneMatch.set(token, hadIfNoneMatch);
      if (hadIfNoneMatch) return new Response(null, { status: 304 });
      return new Response(jsonBodyOfSize(entrySize, 'z'), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: `"etag-${token}"` },
      });
    });

    const clients = [];
    for (let i = 0; i < entryCount; i += 1) {
      const client = createOctokit(`fill-${i}`, `fill-account-${i}`);
      clients.push(client);
      const res = await client.rest.users.getAuthenticated();
      expect(res.data.login.length).toBe(entrySize - 12);
    }

    // Newest entry is still cached: its revalidation replays on 304.
    // (Use a fresh client with the same identity so the request is a refetch
    // only in the sense of a new Octokit instance sharing the cache key.)
    const newest = createOctokit(`fill-${entryCount - 1}`, `fill-account-${entryCount - 1}`);
    const replayed = await newest.rest.users.getAuthenticated();
    expect(seenIfNoneMatch.get(`fill-${entryCount - 1}`)).toBe(true);
    expect(replayed.data.login.length).toBe(entrySize - 12);

    // Oldest entry was evicted to honour the total budget: no If-None-Match.
    const oldest = createOctokit('fill-0', 'fill-account-0');
    await oldest.rest.users.getAuthenticated();
    expect(seenIfNoneMatch.get('fill-0')).toBe(false);
  });
});
