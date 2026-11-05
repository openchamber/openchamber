import { describe, expect, test, vi } from 'vitest';

import { OpenChamberControlError } from '../openchamber-control/error.js';
import { createServiceHostApi } from './service-host-api.js';

const row = (overrides = {}) => ({
  id: 'desk',
  name: 'Desk',
  enabled: true,
  service: { entry: 'service/main.js', runtime: 'host' },
  sessionControl: { content: true },
  instructions: true,
  capabilityGrants: ['service', 'transcript', 'sessionControl', 'instructions'],
  ...overrides,
});

const harness = (guest = row(), overrides = {}) => {
  const control = { resolveSessionDirectory: vi.fn(async () => '/repo'), execute: vi.fn(async () => ({ sessionId: 'ses_1', directory: '/repo', messages: [{ text: 'last' }], sessionStatus: { type: 'busy' } })) };
  const instructions = { set: vi.fn(async () => {}) };
  const emitToFrames = vi.fn();
  const setConfigurationNote = vi.fn();
  const api = createServiceHostApi({
    listGuests: async () => [guest],
    control,
    instructions,
    readSettings: async () => ({ key: 'secret' }),
    emitToFrames,
    setConfigurationNote,
    guestIdOfToken: (token) => (token === 'live-token' ? 'desk' : null),
    ...overrides,
  });
  const call = (method, input, bearer = 'live-token') => api.serve({ bearer, body: { method, input } });
  return { api, control, instructions, emitToFrames, setConfigurationNote, call };
};

describe('service host calls', () => {
  test('refuses a bearer no running service holds, before the body is read', () => {
    const { api } = harness();
    expect(api.refusal('stale')).toMatchObject({ status: 401 });
    expect(api.refusal('live-token')).toBeNull();
  });

  test('starts a session through the control service and answers its id', async () => {
    const { call, control } = harness();
    const answer = await call('sessions.start', { prompt: 'hi', directory: '/repo' });
    expect(control.execute).toHaveBeenCalledWith('session.create', { prompt: 'hi', directory: '/repo' }, undefined, { startedByExtension: 'desk' });
    expect(answer).toEqual({ status: 200, body: { result: { sessionId: 'ses_1', directory: '/repo' } } });
  });

  test('reads a session in its own folder', async () => {
    const { call, control } = harness();
    await call('sessions.status', { sessionId: 'ses_1' });
    expect(control.resolveSessionDirectory).toHaveBeenCalledWith('ses_1');
    expect(control.execute).toHaveBeenCalledWith('session.status', { sessionId: 'ses_1' }, '/repo');
  });

  test('says so when the session is gone', async () => {
    const { call, control } = harness();
    control.resolveSessionDirectory.mockResolvedValueOnce(null);
    expect(await call('sessions.status', { sessionId: 'ses_gone' })).toMatchObject({ status: 404 });
  });

  test('tells the service why a call was refused', async () => {
    const { call, control } = harness();
    control.execute.mockRejectedValueOnce(new OpenChamberControlError('This folder is not trusted', 403));
    expect(await call('sessions.start', { prompt: 'go' })).toMatchObject({ status: 403, body: { error: { message: 'This folder is not trusted' } } });
  });

  test('stops a service that sends prompts without end, new session or not', async () => {
    const { call } = harness();
    for (let index = 0; index < 30; index += 1) expect((await call('sessions.start', { prompt: 'go' })).status).toBe(200);
    for (let index = 0; index < 30; index += 1) expect((await call('sessions.send', { sessionId: 'ses_1', prompt: 'go' })).status).toBe(200);
    for (const refused of [await call('sessions.start', { prompt: 'go' }), await call('sessions.send', { sessionId: 'ses_1', prompt: 'go' })]) {
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('TOO_MANY_PROMPTS');
    }
  });

  test('bounds how often a service changes its status', async () => {
    const { call, setConfigurationNote } = harness();
    for (let index = 0; index < 30; index += 1) expect((await call('status.set', { needsConfiguration: `note ${index}` })).status).toBe(200);
    expect((await call('status.set', { needsConfiguration: 'one more' })).status).toBe(429);
    expect(setConfigurationNote).toHaveBeenCalledTimes(30);
  });

  test('refuses every call of a paused extension, whatever the running process holds', async () => {
    const { call, control } = harness(row({ enabled: false }));
    expect(await call('sessions.send', { sessionId: 'ses_1', prompt: 'hi' })).toMatchObject({ status: 403, body: { error: { code: 'DISABLED' } } });
    expect(control.execute).not.toHaveBeenCalled();
  });

  test('refuses an extension whose approval no longer covers what it asks for', async () => {
    const { call, control } = harness(row({ capabilityGrants: ['service'] }));
    expect(await call('sessions.start', { prompt: 'hi' })).toMatchObject({ status: 403, body: { error: { code: 'DISABLED' } } });
    expect(control.execute).not.toHaveBeenCalled();
  });

  test('a reply needs the transcript grant on top of session control', async () => {
    const guest = row({ sessionControl: {}, capabilityGrants: ['service', 'sessionControl', 'instructions'] });
    const { call, control } = harness(guest);
    expect(await call('sessions.lastReply', { sessionId: 'ses_1' })).toMatchObject({ status: 403, body: { error: { code: 'NOT_GRANTED' } } });
    expect(control.execute).not.toHaveBeenCalled();
  });

  test('a retry sends the session\'s last message again', async () => {
    const { call, control } = harness();
    await call('sessions.retry', { sessionId: 'ses_1' });
    expect(control.execute).toHaveBeenLastCalledWith('session.send', { sessionId: 'ses_1', prompt: 'last' });
  });

  test('a retry with nothing to send says so', async () => {
    const control = { resolveSessionDirectory: async () => '/repo', execute: vi.fn(async () => ({ messages: [] })) };
    const { call } = harness(row(), { control });
    expect(await call('sessions.retry', { sessionId: 'ses_1' })).toMatchObject({ status: 409, body: { error: { code: 'NOTHING_TO_RETRY' } } });
  });

  test('a call that does not parse never runs', async () => {
    const { call, control } = harness();
    expect(await call('sessions.start', { prompt: '' })).toMatchObject({ status: 400 });
    expect(await call('sessions.start', { prompt: 'hi', projectId: 'p', directory: '/repo' })).toMatchObject({ status: 400 });
    expect(await call('sessions.delete', {})).toMatchObject({ status: 400 });
    expect(control.execute).not.toHaveBeenCalled();
  });

  test('a session failure tells the service only what the control service meant for callers', async () => {
    const control = { execute: vi.fn(async () => { throw Object.assign(new Error('secret path /x'), { status: 500 }); }) };
    const { call } = harness(row(), { control });
    const answer = await call('sessions.send', { sessionId: 'ses_1', prompt: 'hi' });
    expect(answer.status).toBe(500);
    expect(JSON.stringify(answer)).not.toContain('secret path');
  });

  test('panel events past the rate are refused and do not reach the frames', async () => {
    let at = 0;
    const { call, emitToFrames } = harness(row(), { now: () => at });
    const answers = [];
    for (let index = 0; index < 32; index += 1) answers.push(await call('panels.emit', { topic: 't', data: index }));
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(30);
    expect(answers.at(-1)).toMatchObject({ status: 429 });
    expect(emitToFrames).toHaveBeenCalledTimes(30);
    at = 1_000;
    expect(await call('panels.emit', { topic: 't' })).toMatchObject({ status: 200 });
  });

  test('a panel event over the size is refused', async () => {
    const { call, emitToFrames } = harness();
    expect(await call('panels.emit', { topic: 't', data: 'x'.repeat(70_000) })).toMatchObject({ status: 413 });
    expect(emitToFrames).not.toHaveBeenCalled();
  });

  test('bounds the characters a service sends its panels each second', async () => {
    const { call, emitToFrames } = harness();
    const answers = [];
    for (let index = 0; index < 5; index += 1) answers.push(await call('panels.emit', { topic: 't', data: 'x'.repeat(60_000) }));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 429]);
    expect(emitToFrames).toHaveBeenCalledTimes(4);
  });

  test('instructions need their own grant', async () => {
    const guest = row({ instructions: undefined, capabilityGrants: ['service', 'transcript', 'sessionControl'] });
    const { call, instructions } = harness(guest);
    expect(await call('instructions.set', { directory: null, text: 'x' })).toMatchObject({ status: 403 });
    expect(instructions.set).not.toHaveBeenCalled();
  });

  test('settings reach the service, and the card note reaches the card', async () => {
    const { call, setConfigurationNote } = harness();
    expect(await call('settings.read', {})).toEqual({ status: 200, body: { result: { settings: { key: 'secret' } } } });
    await call('status.set', { needsConfiguration: 'Connect a workspace' });
    expect(setConfigurationNote).toHaveBeenCalledWith('desk', 'Connect a workspace');
  });
});

describe('reading replies', () => {
  test('the transcript grant from session events does not open replies', async () => {
    const guest = row({ sessionControl: {}, sessionEvents: { events: ['turn-finished'], content: true } });
    const { call, control } = harness(guest);
    expect(await call('sessions.lastReply', { sessionId: 'ses_1' })).toMatchObject({ status: 403, body: { error: { code: 'NOT_GRANTED' } } });
    expect(control.execute).not.toHaveBeenCalled();
  });
});
