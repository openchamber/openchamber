import { describe, expect, it } from 'vitest';

import { createTurnStartReader } from './turn-start.js';

const record = (type, created) => ({ id: `msg_${created}`, type, time: { created } });

/** A fake OpenCode answering desc pages of the given records, newest first. */
const createReader = (newestFirst, { pageSize = 50, failWith = null } = {}) => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (failWith) return { ok: false, status: failWith, json: async () => ({}) };
    const query = new URL(url).searchParams;
    const offset = Number(query.get('cursor') ?? 0);
    const data = newestFirst.slice(offset, offset + pageSize);
    const next = offset + pageSize < newestFirst.length ? String(offset + pageSize) : null;
    return { ok: true, json: async () => ({ data, cursor: { next } }) };
  };
  const reader = createTurnStartReader({
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl,
  });
  return { reader, requests };
};

describe('createTurnStartReader', () => {
  it('starts the running turn at the first message after the last turn ended', async () => {
    const { reader, requests } = createReader([
      record('assistant', 900),
      record('synthetic', 800),
      record('assistant', 700),
      record('user', 600),
      // Picked in the composer while idle, before the prompt was sent.
      record('model-switched', 550),
      record('idle', 500),
      record('user', 100),
    ]);

    expect(await reader.readTurnStart('ses_1')).toBe(600);
    expect(requests).toEqual(['http://127.0.0.1:4096/api/session/ses_1/message?limit=50&order=desc']);
  });

  it('walks back across pages, and takes the first message of a session still in its first turn', async () => {
    const records = Array.from({ length: 120 }, (_, index) => record(index === 119 ? 'user' : 'assistant', 1000 - index));
    const { reader, requests } = createReader(records);

    expect(await reader.readTurnStart('ses_1')).toBe(881);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain('cursor=50');
    expect(requests[1]).not.toContain('order=');
  });

  it('cannot tell a start when the latest record ends a turn, the read fails, or the turn is too long', async () => {
    expect(await createReader([record('idle', 900), record('user', 100)]).reader.readTurnStart('ses_1')).toBeNull();
    expect(await createReader([], { failWith: 404 }).reader.readTurnStart('ses_1')).toBeNull();
    const long = Array.from({ length: 600 }, (_, index) => record('assistant', 10_000 - index));
    expect(await createReader(long).reader.readTurnStart('ses_1')).toBeNull();
  });
});
