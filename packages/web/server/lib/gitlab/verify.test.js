import { describe, expect, it } from 'vitest';
import { verifyGitLabToken } from './verify.js';

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
