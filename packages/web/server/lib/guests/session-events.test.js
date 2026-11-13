import { describe, expect, test } from 'bun:test';
import { translateWireEvent } from '../event-stream/translate-v2.js';

import {
  SESSION_EVENT_FAILURE_BACKOFF_MS,
  SESSION_EVENT_IDLE_DEDUPE_MS,
  createExtensionSessionEvents,
  isSessionEventSubscriber,
} from './session-events.js';
import { SESSION_EVENT_PENDING_MAX } from '@openchamber/sdk';

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const subscriber = (overrides = {}) => ({
  id: 'journal', name: 'Journal', packageRoot: '/pkg/journal', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host' },
  sessionEvents: { events: ['turn-finished', 'turn-failed', 'permission-asked', 'question-asked'] },
  capabilityGrants: ['service'],
  ...overrides,
});

const reader = (overrides = {}) => subscriber({
  id: 'reader', name: 'Reader', packageRoot: '/pkg/reader',
  sessionEvents: { events: ['turn-finished', 'turn-failed', 'permission-asked', 'question-asked'], content: true },
  capabilityGrants: ['service', 'transcript'],
  ...overrides,
});

const idle = (sessionID = 'ses_1', extra = {}) => ({ type: 'session.idle', id: 'evt_idle', created: 1_000, properties: { sessionID, directory: '/repo', ...extra } });

/** The fakes one runtime needs: a catalog, a service proxy, OpenCode reads and manual timers. */
const harness = ({ catalog = [subscriber()], sessions = {}, active = {}, children = {}, metadata = {}, reply = 'Done.', autoAccept = async () => false, inAutoReview = () => false, answer, beforeFetch = async () => {}, metadataRead } = {}) => {
  const calls = [];
  const warnings = [];
  const fetched = [];
  const timers = [];
  let time = 10_000;
  const proxy = async (params) => {
    calls.push(params);
    if (answer) return answer(params);
    return { status: 200, body: JSON.stringify({ ok: true }) };
  };
  const fetchImpl = async (url) => {
    fetched.push(url);
    await beforeFetch(url);
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/api/session/active') return Response.json({ data: active });
    if (pathname === '/api/session') {
      const parent = searchParams.get('parentID');
      return Response.json({ data: (children[parent] ?? []).map((id) => ({ id })), cursor: {} });
    }
    const match = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (match) {
      const record = sessions[decodeURIComponent(match[1])];
      return record ? Response.json({ data: record }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  const runtime = createExtensionSessionEvents({
    listGuests: async () => catalog,
    proxyServiceRequest: proxy,
    persistPath: '/data/extensions.json',
    buildOpenCodeUrl: (path) => `http://opencode${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl,
    fetchLastAssistantMessageText: async () => reply,
    readSessionMetadata: (sessionId) => metadataRead ? metadataRead(sessionId) : metadata[sessionId] ?? null,
    isSessionAutoAccepting: autoAccept,
    isInAutoReview: inAutoReview,
    now: () => time,
    timers: {
      setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
      clearTimeout: (timer) => { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); },
    },
    createId: (() => { let n = 0; return () => `id-${n += 1}`; })(),
    warn: (...args) => warnings.push(args.join(' ')),
  });
  const fireTimers = () => { const due = timers.splice(0); for (const timer of due) timer.fn(); };
  const bodies = () => calls.map((call) => JSON.parse(call.body));
  return { runtime, calls, bodies, warnings, fetched, timers, fireTimers, advance: (ms) => { time += ms; } };
};

describe('isSessionEventSubscriber', () => {
  test('needs an enabled, fully approved package with a subscription and the service grant', () => {
    expect(isSessionEventSubscriber(subscriber())).toBe(true);
    expect(isSessionEventSubscriber(reader())).toBe(true);
    expect(isSessionEventSubscriber(subscriber({ enabled: false }))).toBe(false);
    expect(isSessionEventSubscriber(subscriber({ capabilityGrants: [] }))).toBe(false);
    expect(isSessionEventSubscriber(subscriber({ sessionEvents: undefined }))).toBe(false);
    // Content asked for but not approved: the whole package waits for approval.
    expect(isSessionEventSubscriber(reader({ capabilityGrants: ['service'] }))).toBe(false);
    expect(isSessionEventSubscriber(null)).toBe(false);
  });
});

describe('turn-finished', () => {
  test('keeps the directory for successive translated execution ends without transcript access and invalidates it on a move', async () => {
    const sessions = { ses_1: { id: 'ses_1', location: { directory: '/repo' } } };
    const h = harness({ sessions });
    const execution = (type, id) => {
      for (const payload of translateWireEvent({ type, id, created: 1_000, data: { sessionID: 'ses_1' } })) h.runtime.processPayload(payload);
    };
    execution('session.execution.succeeded', 'end_a');
    await settle();
    execution('session.execution.started', 'start_b');
    execution('session.execution.succeeded', 'end_b');
    await settle();
    expect(h.bodies().map((body) => body.event.project.directory)).toEqual(['/repo', '/repo']);
    sessions.ses_1.location.directory = '/moved';
    for (const payload of translateWireEvent({ type: 'session.moved', id: 'moved', created: 1_001, data: { sessionID: 'ses_1', location: { directory: '/moved' } } })) h.runtime.processPayload(payload);
    execution('session.execution.started', 'start_c');
    execution('session.execution.succeeded', 'end_c');
    await settle();
    expect(h.bodies().at(-1).event.project.directory).toBe('/moved');
    sessions.ses_1.location.directory = '/expired';
    h.advance(60_001);
    execution('session.execution.started', 'start_d');
    execution('session.execution.succeeded', 'end_d');
    await settle();
    expect(h.bodies().at(-1).event.project.directory).toBe('/expired');
  });

  test('a directory read invalidated during a move cannot repopulate the cache', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    const sessions = { ses_1: { id: 'ses_1', location: { directory: '/old' } } };
    let first = true;
    const h = harness({ sessions, beforeFetch: async (url) => {
      if (first && url.endsWith('/api/session/ses_1')) { first = false; started(); await gate; }
    } });
    const end = { type: 'session.idle', properties: { sessionID: 'ses_1' } };
    h.runtime.processPayload(end);
    await reading;
    h.runtime.processPayload({ type: 'session.updated', properties: { sessionID: 'ses_1', info: { id: 'ses_1', directory: '/new' } } });
    release();
    await settle();
    sessions.ses_1.location.directory = '/new';
    h.runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    h.runtime.processPayload(end);
    await settle();
    expect(h.bodies().map((body) => body.event.project.directory)).toEqual(['/old', '/new']);
  });

  test('keeps both turn ends when a new turn starts while the previous idle is reading', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    let first = true;
    const h = harness({ beforeFetch: async (url) => {
      if (first && url.endsWith('/api/session/active')) { first = false; started(); await gate; }
    } });
    h.runtime.processPayload({ ...idle(), id: 'end_a' });
    await reading;
    h.runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    h.runtime.processPayload({ ...idle(), id: 'end_b' });
    await settle();
    release();
    await settle();
    expect(h.bodies().map((body) => body.event.id)).toEqual(['end_a', 'end_b']);
  });

  test('posts the event to every subscriber, with content only to one holding transcript', async () => {
    const h = harness({
      catalog: [subscriber(), reader()],
      sessions: { ses_1: { id: 'ses_1', parentID: null, title: 'Fix the parser', location: { directory: '/repo' } } },
      metadata: { ses_1: { openchamber: { linked_issues: [
        { id: 'linear:OPE-367', kind: 'linear', provider: 'linear', identifier: 'OPE-367', title: 'Secret title', url: 'https://linear.app/x/OPE-367', linkedAt: 1 },
        { id: 'acme/tea#12', kind: 'pull', number: 12, title: 'T', url: 'https://github.com/acme/tea/pull/12' },
        { id: 'broken', kind: 'external' },
      ] } } },
    });
    h.runtime.processPayload(idle(), '/repo');
    await settle();
    expect(h.calls.map((call) => [call.guestId, call.path, call.method, call.timeoutMs, call.idleStopMs, call.granted])).toEqual([
      ['journal', '/session-events', 'POST', 10_000, 600_000, ['service']],
      ['reader', '/session-events', 'POST', 10_000, 600_000, ['service', 'transcript']],
    ]);
    const [plain, rich] = h.bodies();
    expect(plain).toEqual({
      v: 1, requestId: 'id-1',
      event: {
        id: 'evt_idle', type: 'turn-finished', at: 1_000,
        session: { id: 'ses_1', parentId: null },
        project: { directory: '/repo' },
        linked: [
          { id: 'linear:OPE-367', kind: 'linear', url: 'https://linear.app/x/OPE-367', provider: 'linear', identifier: 'OPE-367' },
          { id: 'acme/tea#12', kind: 'pull', url: 'https://github.com/acme/tea/pull/12', number: 12 },
        ],
      },
    });
    expect(rich.event).toEqual(plain.event);
    expect(rich.requestId).toBe('id-2');
    expect(rich.content).toEqual({ type: 'turn-finished', sessionTitle: 'Fix the parser', reply: 'Done.', replyTruncated: false });
    expect(JSON.stringify(plain)).not.toContain('Secret title');
  });

  test('cuts a long reply at the cap and says so', async () => {
    const h = harness({ catalog: [reader()], reply: 'x'.repeat(70_000) });
    h.runtime.processPayload(idle());
    await settle();
    expect(h.bodies()[0].content).toMatchObject({ reply: 'x'.repeat(64_000), replyTruncated: true });
  });

  test('without a subscriber an idle reads nothing', async () => {
    const h = harness({ catalog: [subscriber({ enabled: false }), subscriber({ id: 'other', sessionEvents: { events: ['turn-failed'] } })] });
    h.runtime.processPayload(idle());
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(h.fetched).toHaveLength(0);
  });

  test('a stopped turn, a second idle of the same turn, a child still working, a goal step and an auto-review step announce nothing', async () => {
    const h = harness({ active: { ses_child: { type: 'busy' } }, children: { ses_1: ['ses_child'] } });
    h.runtime.processPayload(idle('ses_1', { aborted: true }));
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls).toHaveLength(0);

    const quiet = harness({ metadata: { ses_goal: { openchamber: { goal: { status: 'active' } } } }, inAutoReview: (sessionId) => sessionId === 'ses_review' });
    quiet.runtime.processPayload(idle('ses_goal'));
    quiet.runtime.processPayload(idle('ses_review'));
    quiet.runtime.processPayload(idle('ses_2'));
    quiet.runtime.processPayload(idle('ses_2'));
    await settle();
    expect(quiet.bodies().map((body) => body.event.session.id)).toEqual(['ses_2']);
    quiet.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    quiet.runtime.processPayload(idle('ses_2'));
    await settle();
    expect(quiet.calls).toHaveLength(2);
  });

  test('waits for an open page, form or permission and announces the idle after the answer', async () => {
    const h = harness();
    h.runtime.processPayload({ type: 'openchamber:page-waiting', properties: { sessionID: 'ses_1', directory: '/repo', page: { id: 'call_1', title: 'Pick one' } } });
    await settle();
    h.runtime.processPayload(idle());
    await settle();
    expect(h.bodies().map((body) => body.event.type)).toEqual(['question-asked']);
    h.runtime.processPayload({ type: 'openchamber:page-settled', properties: { sessionID: 'ses_1', pageID: 'call_1' } });
    h.runtime.processPayload(idle());
    await settle();
    expect(h.bodies().map((body) => body.event.type)).toEqual(['question-asked', 'turn-finished']);

    h.runtime.processPayload({ type: 'form.created', properties: { sessionID: 'ses_1', form: { id: 'form_1', sessionID: 'ses_1', title: 'Which?', fields: [{ title: 'Branch', description: 'main or dev' }] } } });
    await settle();
    h.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    h.runtime.processPayload(idle());
    await settle();
    h.runtime.processPayload({ type: 'form.settled', properties: { sessionID: 'ses_1', formID: 'form_1' } });
    h.runtime.processPayload(idle());
    await settle();
    expect(h.bodies().map((body) => body.event.type)).toEqual(['question-asked', 'turn-finished', 'question-asked', 'turn-finished']);
  });
});

describe('turn-failed', () => {
  test('carries the error and never a reply', async () => {
    let replyReads = 0;
    const h = harness({ catalog: [reader()], sessions: { ses_1: { id: 'ses_1', parentID: 'ses_parent', title: 'Child' } } });
    h.runtime.processPayload({ type: 'session.error', id: 'evt_err', created: 2_000, properties: { sessionID: 'ses_1', error: { name: 'APIError', type: 'APIError', message: 'rate limited' } } });
    await settle();
    const [body] = h.bodies();
    expect(body.event).toMatchObject({ type: 'turn-failed', session: { id: 'ses_1', parentId: 'ses_parent' }, project: { directory: null } });
    expect(body.content).toEqual({ type: 'turn-failed', sessionTitle: 'Child', error: { type: 'APIError', message: 'rate limited' } });
    expect(replyReads).toBe(0);
  });
});

describe('permission-asked', () => {
  const asked = (id = 'perm_1') => ({ type: 'permission.asked', id: `evt_${id}`, created: 3_000, properties: { sessionID: 'ses_1', directory: '/repo', id, action: 'bash', resources: ['rm -rf dist'], message: 'Clean the build' } });

  test('is announced once the debounce passes and the request is still open', async () => {
    const h = harness({ catalog: [reader()] });
    h.runtime.processPayload(asked());
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    h.fireTimers();
    await settle();
    const [body] = h.bodies();
    expect(body.event).toMatchObject({ type: 'permission-asked', permission: { requestId: 'perm_1' } });
    expect(body.content).toEqual({ type: 'permission-asked', sessionTitle: null, action: 'bash', resources: ['rm -rf dist'], message: 'Clean the build' });
    // Asked again (a replayed event): already announced.
    h.runtime.processPayload(asked());
    await settle();
    h.fireTimers();
    await settle();
    expect(h.calls).toHaveLength(1);
  });

  test('a reply before the debounce, or an auto-answered request, announces nothing', async () => {
    const h = harness();
    h.runtime.processPayload(asked('perm_1'));
    await settle();
    h.runtime.processPayload({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'perm_1' } });
    expect(h.timers).toHaveLength(0);
    h.runtime.processPayload(asked('perm_2'));
    await settle();
    // A reply without a request id answers every open permission of the session.
    h.runtime.processPayload({ type: 'permission.replied', properties: { sessionID: 'ses_1' } });
    expect(h.timers).toHaveLength(0);
    h.fireTimers();
    await settle();
    expect(h.calls).toHaveLength(0);

    const auto = harness({ autoAccept: async () => true });
    auto.runtime.processPayload(asked('perm_3'));
    await settle();
    expect(auto.timers).toHaveLength(0);
    // Auto-accept decided only after the ask: checked again when the timer fires.
    let accepting = false;
    const late = harness({ autoAccept: async () => accepting });
    late.runtime.processPayload(asked('perm_4'));
    await settle();
    accepting = true;
    late.fireTimers();
    await settle();
    expect(late.calls).toHaveLength(0);
  });
});

describe('question-asked', () => {
  test('a form of a session is announced with its fields, an MCP elicitation is not', async () => {
    const h = harness({ catalog: [reader()] });
    h.runtime.processPayload({ type: 'form.created', properties: { sessionID: 'global', form: { id: 'form_g', sessionID: 'global', title: 'Token?' } } });
    h.runtime.processPayload({ type: 'form.created', id: 'evt_form', created: 4_000, properties: { sessionID: 'ses_1', directory: '/repo', form: { id: 'form_1', sessionID: 'ses_1', title: 'Which?', fields: [{ title: 'Branch', description: 'main or dev' }, { title: 'Force' }] } } });
    await settle();
    expect(h.bodies()).toHaveLength(1);
    expect(h.bodies()[0].content).toEqual({
      type: 'question-asked', sessionTitle: null,
      ask: { kind: 'form', id: 'form_1', title: 'Which?', fields: [{ title: 'Branch', description: 'main or dev' }, { title: 'Force', description: null }] },
    });
  });
});

describe('delivery', () => {
  test('dropped announcements still track open asks, answers and terminal cleanup', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    const h = harness({ beforeFetch: async (url) => {
      if (url.endsWith('/api/session/ses_0')) { started(); await gate; }
    } });
    const error = (sessionID) => ({ type: 'session.error', properties: { sessionID } });
    h.runtime.processPayload(error('ses_0'));
    await reading;
    for (let i = 1; i <= SESSION_EVENT_PENDING_MAX; i += 1) h.runtime.processPayload(error(`ses_${i}`));
    for (const sessionID of ['ses_waiting', 'ses_cleared']) {
      h.runtime.processPayload({ type: 'openchamber:page-waiting', properties: { sessionID, page: { id: 'page_1', title: 'Pick' } } });
      h.runtime.processPayload({ type: 'permission.asked', properties: { sessionID, id: 'permission_1', action: 'bash' } });
    }
    h.runtime.processPayload(error('ses_cleared'));
    await settle();
    expect(h.fetched).toHaveLength(SESSION_EVENT_PENDING_MAX + 1);
    release();
    await settle();
    h.runtime.processPayload(idle('ses_waiting'));
    h.runtime.processPayload(idle('ses_cleared'));
    await settle();
    expect(h.bodies().filter((body) => body.event.type === 'turn-finished').map((body) => body.event.session.id)).toEqual(['ses_cleared']);
    h.runtime.processPayload({ type: 'openchamber:page-settled', properties: { sessionID: 'ses_waiting', pageID: 'page_1' } });
    h.runtime.processPayload({ type: 'permission.replied', properties: { sessionID: 'ses_waiting', requestID: 'permission_1' } });
    h.runtime.processPayload(idle('ses_waiting'));
    await settle();
    expect(h.bodies().at(-1).event.session.id).toBe('ses_waiting');
  });

  test('bounds accepted preparations before reads start and preserves their arrival order', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    const h = harness({ beforeFetch: async (url) => {
      if (url.endsWith('/api/session/ses_0')) { started(); await gate; }
    } });
    const event = (i) => ({ type: 'session.error', id: `evt_${i}`, properties: { sessionID: `ses_${i}` } });
    h.runtime.processPayload(event(0));
    await reading;
    for (let i = 1; i < SESSION_EVENT_PENDING_MAX + 21; i += 1) h.runtime.processPayload(event(i));
    await settle();
    expect(h.fetched).toHaveLength(SESSION_EVENT_PENDING_MAX + 1);
    expect(h.calls).toHaveLength(0);
    expect(h.warnings).toHaveLength(1);
    release();
    await settle();
    expect(h.bodies().map((body) => body.event.id)).toEqual(Array.from({ length: SESSION_EVENT_PENDING_MAX + 1 }, (_, i) => `evt_${i}`));
    h.runtime.processPayload(event(1_000));
    await settle();
    expect(h.bodies().at(-1).event.id).toBe('evt_1000');
  });

  test('stop drops waiting preparations and prevents follow-up reads from an unfinished preparation', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    let metadataReads = 0;
    const h = harness({
      metadataRead: () => { metadataReads += 1; return null; },
      beforeFetch: async (url) => {
        if (url.endsWith('/api/session/ses_0')) { started(); await gate; }
      },
    });
    const event = (i) => ({ type: 'session.error', properties: { sessionID: `ses_${i}` } });
    h.runtime.processPayload(event(0));
    await reading;
    for (let i = 1; i <= SESSION_EVENT_PENDING_MAX; i += 1) h.runtime.processPayload(event(i));
    await settle();
    expect(metadataReads).toBe(SESSION_EVENT_PENDING_MAX);
    h.runtime.stop();
    release();
    h.runtime.processPayload(event(1_000));
    await settle();
    expect(metadataReads).toBe(SESSION_EVENT_PENDING_MAX);
    expect(h.fetched).toHaveLength(SESSION_EVENT_PENDING_MAX + 1);
    expect(h.calls).toHaveLength(0);
  });

  test('keeps arrival order when the first event record read finishes last', async () => {
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { started = resolve; });
    const h = harness({ beforeFetch: async (url) => {
      if (url.endsWith('/api/session/ses_a')) { started(); await gate; }
    } });
    h.runtime.processPayload({ type: 'session.error', id: 'a', properties: { sessionID: 'ses_a' } });
    await reading;
    h.runtime.processPayload({ type: 'session.error', id: 'b', properties: { sessionID: 'ses_b' } });
    await settle();
    release();
    await settle();
    expect(h.bodies().map((body) => body.event.id)).toEqual(['a', 'b']);
  });

  test('a failed delivery drops that guest\'s events for the backoff, warns once, and reconcile lets it deliver again', async () => {
    let failing = true;
    const h = harness({
      catalog: [subscriber(), subscriber({ id: 'other', packageRoot: '/pkg/other' })],
      answer: (params) => (params.guestId === 'journal' && failing ? { status: 200, body: JSON.stringify({ ok: false, error: 'disk full' }) } : { status: 200, body: '{"ok":true}' }),
    });
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    h.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls.map((call) => call.guestId)).toEqual(['journal', 'other', 'other']);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('journal');
    expect(h.warnings[0]).toContain('disk full');
    expect(h.warnings[0]).not.toContain('ses_1');
    failing = false;
    h.advance(SESSION_EVENT_FAILURE_BACKOFF_MS);
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls.map((call) => call.guestId)).toEqual(['journal', 'other', 'other', 'journal', 'other']);

    failing = true;
    h.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    failing = false;
    await h.runtime.reconcile();
    h.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls.filter((call) => call.guestId === 'journal')).toHaveLength(4);
  });

  test('a follow-up turn that ends within the dedupe window is announced: a turn start resets it', async () => {
    const h = harness();
    h.runtime.processPayload(idle('ses_1'));
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls).toHaveLength(1);
    h.runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls).toHaveLength(2);
  });

  test('a service that cannot start while the package still subscribes is explained once; a pause is not', async () => {
    const missing = Object.assign(new Error('Service entry is missing.'), { code: 'NO_SERVICE' });
    const h = harness({ answer: () => { throw missing; } });
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    h.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('Service entry is missing.');
    expect(h.warnings[0]).not.toContain('ses_1');

    const catalog = [subscriber()];
    const paused = harness({ catalog, answer: () => { catalog[0] = subscriber({ enabled: false }); throw missing; } });
    paused.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(paused.calls).toHaveLength(1);
    expect(paused.warnings).toHaveLength(0);
  });

  test('a guest that is not a subscriber right now drops its queue without a warning or a backoff', async () => {
    const h = harness({ answer: () => { throw Object.assign(new Error('paused'), { code: 'DISABLED' }); } });
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.warnings).toHaveLength(0);
    h.advance(SESSION_EVENT_IDLE_DEDUPE_MS);
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.calls).toHaveLength(2);
  });

  test('an HTTP error or a body that is not the envelope is a failed delivery', async () => {
    const h = harness({ answer: () => ({ status: 500, body: 'boom' }) });
    h.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('HTTP 500');
    const odd = harness({ answer: () => ({ status: 200, body: '{"ok":true,"data":{}}' }) });
    odd.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(odd.warnings).toHaveLength(1);
  });

  test('delivers in order, one request at a time per guest, and caps what waits while the service starts', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let first = true;
    const h = harness({ answer: async () => { if (first) { first = false; await gate; } return { status: 200, body: '{"ok":true}' }; } });
    for (let i = 0; i < 210; i += 1) {
      h.runtime.processPayload({ type: 'session.error', id: `evt_${i}`, properties: { sessionID: `ses_${i}`, error: { type: 'E', message: 'm' } } });
    }
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('200 events');
    release();
    await settle();
    await settle();
    expect(h.calls).toHaveLength(201);
    expect(h.bodies().map((body) => body.event.id).slice(0, 3)).toEqual(['evt_0', 'evt_1', 'evt_2']);
  });

  test('reconcile drops what waits for a guest that stopped being a subscriber, and stop ends everything', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const catalog = [subscriber()];
    const h = harness({ catalog, answer: async () => { await gate; return { status: 200, body: '{"ok":true}' }; } });
    h.runtime.processPayload({ type: 'session.error', id: 'a', properties: { sessionID: 'ses_a', error: { type: 'E', message: 'm' } } });
    h.runtime.processPayload({ type: 'session.error', id: 'b', properties: { sessionID: 'ses_b', error: { type: 'E', message: 'm' } } });
    await settle();
    catalog[0] = subscriber({ enabled: false });
    await h.runtime.reconcile();
    release();
    await settle();
    expect(h.calls).toHaveLength(1);

    const stopping = harness({ catalog: [reader()] });
    stopping.runtime.processPayload({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'perm_1', action: 'bash', resources: [] } });
    await settle();
    expect(stopping.timers).toHaveLength(1);
    stopping.runtime.stop();
    expect(stopping.timers).toHaveLength(0);
    stopping.runtime.processPayload(idle('ses_1'));
    await settle();
    expect(stopping.calls).toHaveLength(0);
  });
});
