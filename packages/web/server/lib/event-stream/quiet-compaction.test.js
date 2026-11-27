import { describe, expect, it, vi } from 'vitest';

import { createQuietCompaction } from './quiet-compaction.js';

const wire = (type, sessionID = 'ses_lead', data = {}) => ({ id: `evt_${type}`, type, created: 500, data: { sessionID, ...data }, location: { directory: '/repo' } });

const setup = ({ time = { idle: 100, viewed: 100 }, since = null, read = async () => {} } = {}) => {
  let clock = 1_000;
  const views = [];
  const settled = [];
  const client = () => ({
    session: {
      get: async () => { await read(); return { id: 'ses_lead', time }; },
      view: async (input) => { views.push(input); },
    },
  });
  const quiet = createQuietCompaction({ client, unreadSince: async () => since, onSettled: (id) => settled.push(id), now: () => clock, warn: () => {} });
  const pass = (types, sessionID) => types.flatMap((type) => quiet.admit(typeof type === 'string' ? wire(type, sessionID) : type).map((payload) => payload.type));
  return { quiet, views, settled, pass, tick: (ms) => { clock += ms; } };
};

const COMPACTION_ONLY = ['session.execution.started', 'session.compaction.started', 'session.compaction.ended', 'session.execution.succeeded'];

describe('quiet compaction', () => {
  it('drops the turn boundaries of a compaction it was told about, keeps a read session read and lets the queue go on', async () => {
    const { quiet, views, settled, pass } = setup();
    await quiet.mark('ses_lead');
    expect(pass(COMPACTION_ONLY)).toEqual(['session.compaction.started', 'session.compaction.ended']);
    expect(settled).toEqual(['ses_lead']);
    await vi.waitFor(() => expect(views).toEqual([{ sessionID: 'ses_lead', idle: 500 }]));
  });

  it('counts a session read below the unread baseline as read, and moves the watermark past the previous idle', async () => {
    const { quiet, views, pass } = setup({ time: { idle: 800 }, since: 900 });
    await quiet.mark('ses_lead');
    pass(COMPACTION_ONLY);
    await vi.waitFor(() => expect(views).toEqual([{ sessionID: 'ses_lead', idle: 801 }]));
  });

  it('leaves an unread session unread and a failed compaction silent', async () => {
    const { quiet, views, pass } = setup({ time: { idle: 100, viewed: 50 } });
    await quiet.mark('ses_lead');
    expect(pass(['session.execution.started', 'session.compaction.started', 'session.compaction.failed', 'session.execution.failed'])).toEqual(['session.compaction.started', 'session.compaction.failed']);
    expect(views).toEqual([]);
  });

  it('lets a turn end through when the compaction never began, or when the turn failed after it', async () => {
    const { quiet, pass } = setup();
    await quiet.mark('ses_lead');
    expect(pass(['session.execution.started', 'session.execution.failed'])).toEqual(['session.execution.failed']);
    await quiet.mark('ses_lead');
    expect(pass(['session.execution.started', 'session.compaction.started', 'session.compaction.ended', 'session.execution.failed']))
      .toEqual(['session.compaction.started', 'session.compaction.ended', 'session.execution.failed']);
  });

  it('sets no mark when a turn ran while it was reading the session', async () => {
    let release;
    const { quiet, pass } = setup({ read: () => new Promise((resolve) => { release = resolve; }) });
    const marking = quiet.mark('ses_lead');
    pass(['session.execution.started', 'session.execution.succeeded']);
    release();
    await marking;
    expect(pass(['session.execution.started'])).toEqual(['session.execution.started']);
  });

  it('turns back into an ordinary turn when anything but the compaction is delivered, or the model takes a step', async () => {
    const delivered = setup();
    await delivered.quiet.mark('ses_lead');
    expect(delivered.pass([
      wire('session.inbox.enqueued', 'ses_lead', { inboxID: 'in_compact', item: { type: 'compaction' } }),
      'session.execution.started',
      wire('session.inbox.delivered', 'ses_lead', { inboxID: 'in_compact' }),
      wire('session.inbox.delivered', 'ses_lead', { inboxID: 'in_prompt' }),
      'session.execution.failed',
    ])).toEqual(['session.inbox.enqueued', 'session.inbox.delivered', 'session.status', 'session.inbox.delivered', 'session.execution.failed']);

    const stepped = setup();
    await stepped.quiet.mark('ses_lead');
    expect(stepped.pass(['session.execution.started', 'session.compaction.ended', 'session.step.started', 'session.execution.succeeded']))
      .toEqual(['session.compaction.ended', 'session.status', 'session.step.started', 'session.execution.succeeded']);
  });

  it('leaves unmarked turns, other sessions and a compaction steered into a running turn alone', async () => {
    const { quiet, pass } = setup();
    expect(pass(COMPACTION_ONLY)).toEqual(COMPACTION_ONLY);
    await quiet.mark('ses_lead');
    expect(pass(COMPACTION_ONLY, 'ses_other')).toEqual(COMPACTION_ONLY);
    pass(COMPACTION_ONLY);
    pass(['session.execution.started']);
    await quiet.mark('ses_lead');
    expect(pass(['session.execution.succeeded', 'session.execution.started'])).toEqual(['session.execution.succeeded', 'session.execution.started']);
  });

  it('forgets a mark whose compaction never started, failed to send, or was made before a reconnect', async () => {
    const { quiet, pass, tick } = setup();
    await quiet.mark('ses_lead');
    tick(30_001);
    expect(pass(['session.execution.started'])).toEqual(['session.execution.started']);
    pass(['session.execution.succeeded']);
    await quiet.mark('ses_lead');
    quiet.unmark('ses_lead');
    expect(pass(['session.execution.started'])).toEqual(['session.execution.started']);
    pass(['session.execution.succeeded']);
    await quiet.mark('ses_lead');
    quiet.reset();
    expect(pass(['session.execution.started'])).toEqual(['session.execution.started']);
  });

  it('ends a quiet turn across a reconnect, and gives way to the next turn when its end was missed', async () => {
    const { quiet, pass } = setup();
    await quiet.mark('ses_lead');
    pass(['session.execution.started', 'session.compaction.started']);
    quiet.reset();
    expect(pass(['session.execution.succeeded'])).toEqual([]);
    await quiet.mark('ses_lead');
    pass(['session.execution.started']);
    quiet.reset();
    expect(pass(['session.execution.started', 'session.execution.succeeded'])).toEqual(['session.execution.started', 'session.execution.succeeded']);
  });

  it('keeps a quiet session out of the running list', async () => {
    const { quiet, pass } = setup();
    expect(quiet.filterActive({ data: { ses_lead: {}, ses_other: {} } })).toEqual({ data: { ses_lead: {}, ses_other: {} } });
    await quiet.mark('ses_lead');
    pass(['session.execution.started']);
    expect(quiet.filterActive({ data: { ses_lead: {}, ses_other: {} } })).toEqual({ data: { ses_other: {} } });
    pass(['session.execution.succeeded']);
    expect(quiet.filterActive({ ses_lead: {} })).toEqual({ ses_lead: {} });
  });
});
