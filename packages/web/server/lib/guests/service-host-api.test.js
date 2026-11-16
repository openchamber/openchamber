import { describe, expect, test, vi } from 'vitest';

import { OpenChamberControlError } from '../openchamber-control/error.js';
import { SERVICE_MARKS_MAX, SERVICE_MARK_RATE_MAX } from '@openchamber/sdk';

import { enterpriseBlockedCapabilities } from './enterprise.js';
import { createGuestMarks } from './marks.js';
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
  const control = {
    resolveSessionDirectory: vi.fn(async () => '/repo'),
    execute: vi.fn(async () => ({ sessionId: 'ses_1', directory: '/repo', messages: [{ text: 'last' }], sessionStatus: { type: 'busy' } })),
    stopSession: vi.fn(async () => true),
    answerPermission: vi.fn(async () => {}),
    answerForm: vi.fn(async () => {}),
    dismissOpenForms: vi.fn(async () => {}),
  };
  const instructions = { set: vi.fn(async () => {}) };
  const emitToFrames = vi.fn();
  const setConfigurationNote = vi.fn();
  const guestIdOfToken = (token) => (token === 'live-token' ? 'desk' : null);
  const marks = createGuestMarks({ guestIdOfToken });
  const api = createServiceHostApi({
    listGuests: async () => [guest],
    control,
    instructions,
    readSettings: async () => ({ key: 'secret' }),
    emitToFrames,
    setConfigurationNote,
    marks,
    guestIdOfToken,
    ...overrides,
  });
  const call = (method, input, bearer = 'live-token') => api.serve({ bearer, body: { method, input } });
  return { api, control, instructions, emitToFrames, setConfigurationNote, marks, call };
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
    const control = { dismissOpenForms: async () => {}, execute: vi.fn(async () => { throw Object.assign(new Error('secret path /x'), { status: 500 }); }) };
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

describe('acting for the user', () => {
  const answering = (overrides = {}) => row({
    sessionControl: { content: true, answers: true },
    capabilityGrants: ['service', 'transcript', 'sessionControl', 'sessionAnswers', 'instructions'],
    ...overrides,
  });

  test('a stop needs session control only', async () => {
    const { call, control } = harness();
    expect(await call('sessions.stop', { sessionId: 'ses_1' })).toEqual({ status: 200, body: { result: { stopped: true } } });
    expect(control.stopSession).toHaveBeenCalledWith('ses_1');
  });

  test('a message dismisses the open form before it goes, so it does not wait behind it', async () => {
    const { call, control } = harness();
    await call('sessions.send', { sessionId: 'ses_1', prompt: 'use the second one' });
    expect(control.dismissOpenForms).toHaveBeenCalledWith('ses_1');
    expect(control.dismissOpenForms.mock.invocationCallOrder[0]).toBeLessThan(control.execute.mock.invocationCallOrder[0]);
  });

  test('answers are refused without sessionControl.answers, whatever the grant says', async () => {
    const { call, control } = harness(row({ capabilityGrants: ['service', 'transcript', 'sessionControl', 'sessionAnswers', 'instructions'] }));
    expect(await call('sessions.answerPermission', { sessionId: 'ses_1', requestId: 'per_1', decision: 'allow' }))
      .toMatchObject({ status: 403, body: { error: { code: 'NOT_GRANTED' } } });
    expect(await call('sessions.answerForm', { sessionId: 'ses_1', formId: 'frm_1', values: { pick: 'a' } }))
      .toMatchObject({ status: 403, body: { error: { code: 'NOT_GRANTED' } } });
    expect(control.answerPermission).not.toHaveBeenCalled();
    expect(control.answerForm).not.toHaveBeenCalled();
  });

  test('an allow lets the agent do it once, and only a refusal carries a note', async () => {
    const { call, control } = harness(answering());
    await call('sessions.answerPermission', { sessionId: 'ses_1', requestId: 'per_1', decision: 'allow', message: 'ignored' });
    expect(control.answerPermission).toHaveBeenLastCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'once', message: undefined });
    await call('sessions.answerPermission', { sessionId: 'ses_1', requestId: 'per_2', decision: 'deny', message: 'Not on main' });
    expect(control.answerPermission).toHaveBeenLastCalledWith({ sessionID: 'ses_1', requestID: 'per_2', decision: 'reject', message: 'Not on main' });
    expect(await call('sessions.answerPermission', { sessionId: 'ses_1', requestId: 'per_3', decision: 'always' })).toMatchObject({ status: 400 });
  });

  test('a form takes values or is dismissed with null', async () => {
    const { call, control } = harness(answering());
    expect(await call('sessions.answerForm', { sessionId: 'ses_1', formId: 'frm_1', values: { pick: 'a', tags: ['x'] } }))
      .toEqual({ status: 200, body: { result: { answered: true } } });
    expect(control.answerForm).toHaveBeenLastCalledWith({ sessionID: 'ses_1', formID: 'frm_1', answer: { pick: 'a', tags: ['x'] }, message: undefined });
    await call('sessions.answerForm', { sessionId: 'ses_1', formId: 'frm_2', values: null, message: 'Answered in Telegram' });
    expect(control.answerForm).toHaveBeenLastCalledWith({ sessionID: 'ses_1', formID: 'frm_2', answer: null, message: 'Answered in Telegram' });
  });

  test('an answer to a request that already settled says so', async () => {
    const { call, control } = harness(answering());
    control.answerPermission.mockRejectedValueOnce(new OpenChamberControlError('This request is no longer waiting for an answer', 404));
    expect(await call('sessions.answerPermission', { sessionId: 'ses_1', requestId: 'per_1', decision: 'allow' }))
      .toMatchObject({ status: 404, body: { error: { message: 'This request is no longer waiting for an answer' } } });
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

describe('sidebar marks', () => {
  const marking = (overrides = {}) => row({
    sessionControl: undefined,
    instructions: undefined,
    marks: true,
    capabilityGrants: ['service', 'marks'],
    ...overrides,
  });
  const failed = { icon: 'close-circle', tone: 'error', text: '2 tests failed' };
  const target = { sessionId: 'ses_1' };

  test('a service with the approval sets, replaces and removes a mark', async () => {
    const { call, marks } = harness(marking());
    expect(await call('marks.set', { target, mark: failed })).toEqual({ status: 200, body: { result: { saved: true } } });
    expect(await call('marks.set', { target: { directory: '/repo', branch: 'main' }, mark: { ...failed, url: 'https://ci.example/7' } })).toMatchObject({ status: 200 });
    expect(marks.list('desk')).toEqual([
      { target, mark: failed },
      { target: { directory: '/repo', branch: 'main' }, mark: { ...failed, url: 'https://ci.example/7' } },
    ]);
    expect(await call('marks.set', { target, mark: null })).toMatchObject({ status: 200 });
    expect(marks.list('desk')).toHaveLength(1);
  });

  test('needs its own approval, and a manifest that still asks for it', async () => {
    const withoutGrant = harness(marking({ marks: undefined, capabilityGrants: ['service'] }));
    expect(await withoutGrant.call('marks.set', { target, mark: failed })).toMatchObject({ status: 403, body: { error: { code: 'NOT_GRANTED' } } });
    expect(withoutGrant.marks.list('desk')).toEqual([]);
    // The grant of a version that asked for marks, under a manifest that no longer does.
    const leftover = harness(marking({ marks: undefined }));
    expect(await leftover.call('marks.set', { target, mark: failed })).toMatchObject({ status: 403, body: { error: { code: 'NOT_GRANTED' } } });
    expect(leftover.marks.list('desk')).toEqual([]);
  });

  test('a paused or unapproved extension sets none, whatever its process still holds', async () => {
    for (const guest of [marking({ enabled: false }), marking({ capabilityGrants: [] }), marking({ capabilityGrants: ['marks'] })]) {
      const { call, marks } = harness(guest);
      expect(await call('marks.set', { target, mark: failed })).toMatchObject({ status: 403, body: { error: { code: 'DISABLED' } } });
      expect(marks.list('desk')).toEqual([]);
    }
  });

  test('enterprise mode refuses the service, and its marks with it', async () => {
    const guest = marking();
    const blocked = enterpriseBlockedCapabilities(guest, { source: 'zip' }, { enterpriseMode: true, allowedExtensions: [] });
    expect(blocked).toEqual(['service']);
    // As the catalog lists it then: the refused capability is no longer granted.
    const listed = { ...guest, enterpriseBlocked: blocked, capabilityGrants: guest.capabilityGrants.filter((capability) => !blocked.includes(capability)) };
    const { call, marks } = harness(listed);
    expect(await call('marks.set', { target, mark: failed })).toMatchObject({ status: 403, body: { error: { code: 'DISABLED' } } });
    expect(marks.list('desk')).toEqual([]);
  });

  test('a mark that does not parse is refused before anything is read', async () => {
    const listGuests = vi.fn(async () => [marking()]);
    const { call, marks } = harness(marking(), { listGuests });
    for (const input of [
      { target, mark: { ...failed, tone: 'red' } },
      { target, mark: { ...failed, url: 'http://ci.example/7' } },
      { target, mark: { ...failed, html: '<b>x</b>' } },
      { target: { branch: 'main' }, mark: failed },
      { target },
    ]) {
      expect((await call('marks.set', input)).status).toBe(400);
    }
    expect(listGuests).not.toHaveBeenCalled();
    expect(marks.list('desk')).toEqual([]);
  });

  test('bounds how often marks change, and a mark set to what it is costs nothing', async () => {
    const { call, marks } = harness(marking());
    for (let index = 0; index < SERVICE_MARK_RATE_MAX; index += 1) {
      expect((await call('marks.set', { target, mark: { ...failed, text: `run ${index}` } })).status).toBe(200);
      expect((await call('marks.set', { target, mark: { ...failed, text: `run ${index}` } })).status).toBe(200);
    }
    expect(await call('marks.set', { target, mark: { ...failed, text: 'one more' } })).toMatchObject({ status: 429, body: { error: { code: 'TOO_MANY_EVENTS' } } });
    expect(marks.list('desk')).toEqual([{ target, mark: { ...failed, text: `run ${SERVICE_MARK_RATE_MAX - 1}` } }]);
    // Still what it already is: answered as saved.
    expect((await call('marks.set', { target, mark: { ...failed, text: `run ${SERVICE_MARK_RATE_MAX - 1}` } })).status).toBe(200);
  });

  test('the budget comes back as the minute passes', async () => {
    let at = 0;
    const { call } = harness(marking(), { now: () => at });
    for (let index = 0; index < SERVICE_MARK_RATE_MAX; index += 1) await call('marks.set', { target, mark: { ...failed, text: `run ${index}` } });
    expect((await call('marks.set', { target, mark: failed })).status).toBe(429);
    at = 60_000;
    expect((await call('marks.set', { target, mark: failed })).status).toBe(200);
  });

  test('a service that holds every mark it may is told to remove one', async () => {
    let at = 0;
    const { call, marks } = harness(marking(), { now: () => at });
    for (let index = 0; index < SERVICE_MARKS_MAX; index += 1) {
      at += 60_000;
      expect((await call('marks.set', { target: { sessionId: `ses_${index}` }, mark: failed })).status).toBe(200);
    }
    expect(await call('marks.set', { target: { sessionId: 'one-more' }, mark: failed })).toMatchObject({ status: 409, body: { error: { code: 'TOO_MANY_MARKS' } } });
    expect(marks.list('desk')).toHaveLength(SERVICE_MARKS_MAX);
  });

  test('a call that finishes reading the catalog after its process stopped writes nothing', async () => {
    let running = true;
    const guestIdOfToken = (token) => (running && token === 'live-token' ? 'desk' : null);
    const marks = createGuestMarks({ guestIdOfToken });
    let release;
    const reading = new Promise((resolve) => {
      release = resolve;
    });
    const { call } = harness(marking(), {
      guestIdOfToken,
      marks,
      listGuests: async () => {
        await reading;
        return [marking()];
      },
    });
    const pending = call('marks.set', { target, mark: failed });
    running = false;
    release();
    expect(await pending).toMatchObject({ status: 401, body: { error: { code: 'HANDLE_UNKNOWN' } } });
    running = true;
    expect(marks.list('desk')).toEqual([]);
  });
});
