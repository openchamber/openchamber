import { describe, expect, it, vi } from 'vitest';
import { AUTH_BODY_MAX_BYTES, GitLabRequestError } from './network.js';
import { verifyGitLabToken } from './verify.js';


const chunked = (chunks, status = 200) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}), { status, headers: { 'Content-Type': 'application/json' } });

describe('verifyGitLabToken', () => {
  it('parses a legitimate user answer', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 7, username: 'drew', name: 'Drew' }));
    await expect(verifyGitLabToken({ origin: 'https://gitlab.example.com', token: 'tok', fetch }))
      .resolves.toEqual({ id: 7, login: 'drew', name: 'Drew' });
    expect(fetch.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/user');
  });

  it('keeps a refused token classified as invalid-token', async () => {
    const fetch = vi.fn(async () => Response.json({ message: '401 Unauthorized' }, { status: 401 }));
    await expect(verifyGitLabToken({ origin: 'https://gitlab.example.com', token: 'bad', fetch }))
      .rejects.toMatchObject({ kind: 'invalid-token', status: 401 });
  });

  it('refuses a streamed over-cap user answer with no content-length as provider-error (#1021)', async () => {
    const fetch = vi.fn(async () => chunked(['x'.repeat(600 * 1024), 'x'.repeat(600 * 1024)]));
    const error = await verifyGitLabToken({ origin: 'https://gitlab.example.com', token: 'tok', fetch }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GitLabRequestError);
    expect(error).toMatchObject({ kind: 'provider-error', status: 200 });
  });

  it('refuses a declared over-cap user answer as provider-error', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(AUTH_BODY_MAX_BYTES + 1), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(verifyGitLabToken({ origin: 'https://gitlab.example.com', token: 'tok', fetch }))
      .rejects.toMatchObject({ kind: 'provider-error', status: 200 });
  });
});

// ---- upstream tests ----

const origin = 'https://gitlab.example.com';
const token = 'test-token';

describe('GitLab token verification', () => {
  it('checks the selected instance with a bearer token and preserves the parsed user', async () => {
    let request;
    const fetch = async (url, init) => {
      request = { url, init };
      return Response.json({ id: 7, username: ' user ', avatar_url: 'avatar', name: 'Name', email: 'email' });
    };
    await expect(verifyGitLabToken({ origin, token, fetch })).resolves.toEqual({
      id: 7, login: 'user', avatarUrl: 'avatar', name: 'Name', email: 'email',
    });
    expect(request.url).toBe(`${origin}/api/v4/user`);
    expect(request.init).toMatchObject({
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'error',
    });
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [401, 'invalid-token', 'GitLab token is invalid'],
    [403, 'unavailable', 'GitLab token verification is forbidden'],
    [429, 'temporarily-unavailable', 'GitLab is temporarily unavailable'],
    [503, 'temporarily-unavailable', 'GitLab is temporarily unavailable'],
    [404, 'provider-error', 'Failed to verify GitLab token'],
  ])('preserves the failure for HTTP %s', async (status, kind, message) => {
    const fetch = async () => new Response(null, { status });
    await expect(verifyGitLabToken({ origin, token, fetch })).rejects.toMatchObject({ status, kind, message });
  });

  it.each([
    [null, 'GitLab instance is unreachable'],
    [undefined, 'GitLab instance is unreachable'],
    ['plain rejection', 'GitLab instance is unreachable'],
    [{ message: '' }, 'GitLab instance is unreachable'],
    [{ message: 0 }, 'GitLab instance is unreachable'],
    [{ message: false }, 'GitLab instance is unreachable'],
    [{ message: 23 }, '23'],
    [{ message: { toString: () => 'custom message' } }, 'custom message'],
    [Object.create({ message: 'inherited message' }), 'inherited message'],
  ])('preserves rejection message coercion for %j', async (error, message) => {
    const fetch = async () => { throw error; };
    await expect(verifyGitLabToken({ origin, token, fetch })).rejects.toMatchObject({
      kind: 'unreachable', status: null, message,
    });
  });

  it('reads a rejection getter once with the original receiver', async () => {
    let reads = 0;
    const error = {
      text: 'getter message',
      get message() {
        reads += 1;
        expect(this).toBe(error);
        return this.text;
      },
    };
    const fetch = async () => { throw error; };
    await expect(verifyGitLabToken({ origin, token, fetch })).rejects.toMatchObject({ message: 'getter message' });
    expect(reads).toBe(1);
  });

  it('leaves malformed user payloads rejected by the parser', async () => {
    const fetch = async () => Response.json({ id: 7, username: '' });
    await expect(verifyGitLabToken({ origin, token, fetch })).rejects.toThrow('Invalid GitLab user response');
  });
});
