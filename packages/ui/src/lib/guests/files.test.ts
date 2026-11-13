import { afterEach, describe, expect, test } from 'bun:test';

import { guestFileOperation } from './files';

const originalFetch = globalThis.fetch;

type RecordedCall = { url: string; headers: Headers };

/** The two answer bodies these tests stub: a read result, and a refusal. */
type StubBody =
  | { ok: true; result: { content: string } }
  | { error: string; message: string };

const stubFetch = (calls: RecordedCall[], body: StubBody = { ok: true, result: { content: 'demo' } }, status = 200): typeof fetch => (
  async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json(body, { status });
  }
);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('guestFileOperation directory transport', () => {
  test('carries a directory outside Latin-1 the way the server decodes it', async () => {
    // A project path with characters outside Latin-1 cannot ride a header
    // value as-is: `Headers.set` throws and the whole call reads as a rejected
    // host operation. It travels percent-encoded and marked, the convention
    // the rest of the runtime already uses, and the server decodes it back.
    const calls: RecordedCall[] = [];
    globalThis.fetch = stubFetch(calls);

    const result = await guestFileOperation('guest-1', { op: 'read', path: '~/.config/sdk-context-repro/sample.txt' }, '/tmp/oc-project-中文');

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-opencode-directory')).toBe(encodeURIComponent('/tmp/oc-project-中文'));
    expect(calls[0].headers.get('x-opencode-directory-encoding')).toBe('uri');
    expect(result).toEqual({ ok: true, result: { content: 'demo' } });
  });

  test('sends an ASCII directory unchanged and unmarked', async () => {
    const calls: RecordedCall[] = [];
    globalThis.fetch = stubFetch(calls);

    await guestFileOperation('guest-1', { op: 'read', path: 'README.md' }, '/tmp/oc-project-ascii');

    expect(calls[0].headers.get('x-opencode-directory')).toBe('/tmp/oc-project-ascii');
    expect(calls[0].headers.get('x-opencode-directory-encoding')).toBeNull();
  });

  test('omits the directory when no project is open', async () => {
    // A filesystem-scope call has no project: the server answers a relative
    // path with NO_DIRECTORY, and a global one needs no context at all.
    const calls: RecordedCall[] = [];
    globalThis.fetch = stubFetch(calls);

    await guestFileOperation('guest-1', { op: 'read', path: '~/.config/sdk-context-repro/sample.txt' }, null);

    expect(calls[0].headers.get('x-opencode-directory')).toBeNull();
  });

  test('reports the server refusal instead of a generic failure', async () => {
    const calls: RecordedCall[] = [];
    globalThis.fetch = stubFetch(calls, { error: 'BAD_PATH', message: 'Path is outside the project' }, 400);

    const result = await guestFileOperation('guest-1', { op: 'read', path: '../outside.txt' }, '/tmp/oc-project-ascii');

    expect(result).toEqual({ ok: false, code: 'BAD_PATH', message: 'Path is outside the project' });
  });
});
