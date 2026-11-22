import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeArchiveAt } from './opencode-archive-at.js';

// Oracle: OpenCode's session.update contract (developing-today-forks/opencode#2686):
// PATCH /api/session/:id with { archived: true, experimental: { archivedAt } },
// 204 on success, 404 with { _tag: 'SessionNotFoundError' } for a session it does not have.
const answering = (status, body) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

const archiveAtWith = (fetchImpl) => createOpenCodeArchiveAt({
  baseUrl: () => 'http://opencode.local',
  headers: () => ({ Authorization: 'Basic abc' }),
  fetchImpl,
});

describe('archive at a given time', () => {
  it('sends the time beside archived: true on the session update', async () => {
    const fetchImpl = answering(204);

    await archiveAtWith(fetchImpl)('ses_a/b', 1_700_000_000_123);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://opencode.local/api/session/ses_a%2Fb');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ archived: true, experimental: { archivedAt: 1_700_000_000_123 } });
    expect(new Headers(init.headers).get('authorization')).toBe('Basic abc');
  });

  it("calls only OpenCode's own not-found answer a missing session", async () => {
    await expect(archiveAtWith(answering(404, { _tag: 'SessionNotFoundError', sessionID: 'ses_x' }))('ses_x', 1))
      .rejects.toMatchObject({ _tag: 'SessionNotFoundError' });
    const otherNotFound = archiveAtWith(answering(404, { _tag: 'LocationNotFoundError' }))('ses_x', 1);
    await expect(otherNotFound).rejects.toThrow('OpenCode answered 404');
    await expect(otherNotFound).rejects.not.toHaveProperty('_tag');
    await expect(archiveAtWith(answering(500, { message: 'boom' }))('ses_x', 1)).rejects.toThrow('OpenCode answered 500');
  });
});
