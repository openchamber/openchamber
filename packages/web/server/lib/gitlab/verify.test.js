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
