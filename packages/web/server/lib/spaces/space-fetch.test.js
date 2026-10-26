import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createSpaceFetch } from './space-fetch.js';

const answer = (statusCode, body = '') => {
  const response = Readable.from(body ? [Buffer.from(body)] : []);
  response.statusCode = statusCode;
  return response;
};

describe('createSpaceFetch', () => {
  it('reads a session inside the space and answers it as a fetch response', async () => {
    const requestInside = vi.fn(async () => answer(200, '{"data":{"id":"ses_1","title":"Fix"}}'));
    const fetchFor = createSpaceFetch({ requestInside });

    const response = await fetchFor('space1')('http://space/api/session/ses_1/message?limit=5');

    expect(requestInside).toHaveBeenCalledWith('space1', expect.objectContaining({ path: '/api/session/ses_1/message?limit=5' }));
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ data: { id: 'ses_1', title: 'Fix' } });
  });

  it('passes a refusal from inside on as its status, without a body', async () => {
    const fetchFor = createSpaceFetch({ requestInside: async () => answer(404, 'not found') });

    const response = await fetchFor('space1')('http://space/api/session/ses_1');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('refuses anything but a read of the space\'s sessions, before asking the space', async () => {
    const requestInside = vi.fn();
    const fetchFor = createSpaceFetch({ requestInside })('space1');

    await expect(fetchFor('http://space/api/config')).rejects.toThrow();
    await expect(fetchFor('http://space/api/sessionx')).rejects.toThrow();
    await expect(fetchFor('http://space/api/session/ses_1', { method: 'POST' })).rejects.toThrow();
    expect(requestInside).not.toHaveBeenCalled();
  });

  it('fails an answer past the cap', async () => {
    const fetchFor = createSpaceFetch({ requestInside: async () => answer(200, 'x'.repeat(64)), maxBytes: 16 });

    await expect(fetchFor('space1')('http://space/api/session/ses_1')).rejects.toThrow(/exceeds/);
  });

  it('fails a body that stops in the middle, at the deadline, and closes it', async () => {
    const stalled = new PassThrough();
    stalled.statusCode = 200;
    stalled.write('{"data":');
    const fetchFor = createSpaceFetch({ requestInside: async () => stalled, timeoutMs: 50 });

    await expect(fetchFor('space1')('http://space/api/session/ses_1')).rejects.toThrow();
    expect(stalled.destroyed).toBe(true);
  });

  it('fails a space that never answers, at the deadline', async () => {
    const fetchFor = createSpaceFetch({ requestInside: () => new Promise(() => {}), timeoutMs: 50 });

    await expect(fetchFor('space1')('http://space/api/session/ses_1')).rejects.toThrow();
  });

  it('fails an answer that closes before its end', async () => {
    const cut = new PassThrough();
    cut.statusCode = 200;
    cut.write('{"data":');
    const fetchFor = createSpaceFetch({ requestInside: async () => cut });

    const read = fetchFor('space1')('http://space/api/session/ses_1');
    setTimeout(() => cut.destroy(), 10);
    await expect(read).rejects.toThrow(/closed before its end/);
  });

  it('follows the caller\'s own signal', async () => {
    const stalled = new PassThrough();
    stalled.statusCode = 200;
    const controller = new AbortController();
    const fetchFor = createSpaceFetch({ requestInside: async () => stalled });

    const read = fetchFor('space1')('http://space/api/session/ses_1', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller gave up')), 10);
    await expect(read).rejects.toThrow(/caller gave up/);
  });
});
