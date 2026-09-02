import { afterEach, describe, expect, test } from 'bun:test';

import { fileReferenceExists } from './fileReferenceStat';

const originalFetch = globalThis.fetch;

const calls: Array<{ url: string; headers: Headers }> = [];

const stubFetchWith = (respond: () => Response) => {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    return respond();
    // SAFETY: the stub preserves the fetch signature; every caller in this
    // file restores globalThis.fetch in afterEach.
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fileReferenceExists directory scoping (issue 3019)', () => {
  test('sends the session directory on the stat probe', async () => {
    stubFetchWith(() => new Response(JSON.stringify({ path: '/repo-b/src/index.ts', isFile: true, size: 12 }), { status: 200 }));

    const exists = await fileReferenceExists('/repo-b/src/index.ts', '/repo-b');

    expect(exists).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/fs/stat?path=%2Frepo-b%2Fsrc%2Findex.ts&optional=true');
    expect(calls[0].headers.get('x-opencode-directory')).toBe('/repo-b');
  });

  test('treats a workspace rejection under one directory as unknown under another directory', async () => {
    // Directory A resolves the workspace on the server (the browsed
    // lastDirectory), so the probe for a path under B is rejected with 400
    // and resolves false. The same path probed under B itself must issue a
    // fresh request rather than reuse A's cached rejection.
    stubFetchWith(() => {
      const directoryHint = calls[calls.length - 1]?.headers.get('x-opencode-directory') ?? null;
      if (directoryHint !== '/repo-b') {
        return new Response(JSON.stringify({ error: 'Path is outside of active workspace' }), { status: 400 });
      }
      return new Response(JSON.stringify({ path: '/repo-b/lib/main.ts', isFile: true, size: 12 }), { status: 200 });
    });

    const rejectedUnderA = await fileReferenceExists('/repo-b/lib/main.ts', '/repo-a');
    const acceptedUnderB = await fileReferenceExists('/repo-b/lib/main.ts', '/repo-b');

    expect(rejectedUnderA).toBe(false);
    expect(acceptedUnderB).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('serves a repeated probe under the same directory from the cache', async () => {
    stubFetchWith(() => new Response(JSON.stringify({ path: '/repo-c/lib.ts', isFile: true, size: 4 }), { status: 200 }));

    await fileReferenceExists('/repo-c/lib.ts', '/repo-c');
    const warm = await fileReferenceExists('/repo-c/lib.ts', '/repo-c');

    expect(warm).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
