import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';

import { SURFACE_FRAME_PATH, SURFACE_INPUT_PATH, SURFACE_CONTROL_PATH, SURFACE_RESIZE_PATH, SURFACE_CLIPBOARD_PATH } from '@openchamber/sdk';
import WebSocket from 'ws';

import { GuestServiceError } from './service.js';
import { createGuestSurfaceRuntime, isSurfaceGuest } from './surface.js';

const surfaceGuest = (overrides = {}) => ({
  id: 'sim',
  name: 'Simulator',
  packageRoot: '/ext/sim',
  enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', surface: true },
  capabilityGrants: ['service'],
  panel: { id: 'sim', name: 'Simulator', icon: 'window' },
  ...overrides,
});

/**
 * A service that never spawns: frames are pushed by the test, every other
 * call is recorded. The frame request waits like a real service would.
 */
const createFakeService = () => {
  const calls = [];
  const frames = [];
  const waiters = [];
  let failWith = null;
  /** Test hook: a promise the input handler awaits before answering. */
  let inputGate = null;
  const pushFrame = (frame) => {
    frames.push(frame);
    for (const wake of waiters.splice(0)) wake();
  };
  const nextFrameAfter = (seq) => frames.find((frame) => frame.seq > seq) ?? null;
  const completed = [];
  let inputStatus = 204;
  const openServiceRequest = async ({ path, method, body, query, headers, signal }) => {
    calls.push({ path, method, body: body ? JSON.parse(body) : undefined, query, headers });
    if (failWith) throw failWith;
    if (path === SURFACE_INPUT_PATH && inputGate) {
      const gate = inputGate;
      inputGate = null;
      await gate;
    }
    if (path === SURFACE_INPUT_PATH) completed.push(JSON.parse(body).events[0]);
    let response;
    if (path === SURFACE_FRAME_PATH) {
      const after = Number(query.after);
      let frame = nextFrameAfter(after);
      if (!frame) {
        await new Promise((resolve) => {
          const wake = () => resolve();
          waiters.push(wake);
          signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 300);
        });
        frame = nextFrameAfter(after);
      }
      if (signal?.aborted) throw new GuestServiceError('cancelled', 'CANCELLED');
      response = frame
        ? new Response(frame.bytes, {
          status: 200,
          headers: {
            'content-type': frame.mime ?? 'image/png',
            'x-surface-seq': String(frame.seq),
            'x-surface-width': String(frame.width ?? 320),
            'x-surface-height': String(frame.height ?? 200),
            ...(frame.title ? { 'x-surface-title': frame.title } : {}),
            ...(frame.agentActive ? { 'x-surface-agent-active': '1' } : {}),
          },
        })
        : new Response(null, { status: 204 });
    } else if (path === SURFACE_RESIZE_PATH) {
      response = Response.json({ width: 640, height: 400 });
    } else if (path === SURFACE_CLIPBOARD_PATH) {
      response = Response.json({ text: 'copied inside' });
    } else if (path === SURFACE_INPUT_PATH) {
      response = new Response(null, { status: inputStatus });
    } else {
      response = new Response(null, { status: 204 });
    }
    return { response, finished: () => undefined };
  };
  return {
    calls,
    completed,
    pushFrame,
    gateNextInput: (promise) => { inputGate = promise; },
    answerInputWith: (status) => { inputStatus = status; },
    fail: (error) => { failWith = error; for (const wake of waiters.splice(0)) wake(); },
    openServiceRequest,
    callsTo: (path) => calls.filter((call) => call.path === path),
  };
};

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const openViewer = (port, guestId = 'sim') => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/guests/${guestId}/surface/ws`);
  ws.binaryType = 'arraybuffer';
  const inbox = [];
  const waiting = [];
  ws.on('message', (data, isBinary) => {
    // Bun's `ws` hands text frames over as a Uint8Array, not a Buffer.
    const item = isBinary ? { binary: Buffer.from(data) } : JSON.parse(Buffer.from(data).toString('utf8'));
    const waiter = waiting.shift();
    if (waiter) waiter(item);
    else inbox.push(item);
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiting.push(r)));
  const send = (message) => ws.send(JSON.stringify(message));
  ws.on('open', () => resolve({ ws, next, send, closed: new Promise((r) => ws.on('close', r)) }));
  ws.on('error', reject);
  ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade ${res.statusCode}`)));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const createHarness = async ({ guest = surfaceGuest(), rejectUpgradeAuth = false } = {}) => {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const service = createFakeService();
  const holds = [];
  const rejected = [];
  const runtime = createGuestSurfaceRuntime({
    server,
    uiAuthController: rejectUpgradeAuth ? { enabled: true, ensureSessionToken: async () => null } : null,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade: (socket, status, message) => {
      rejected.push({ status, message });
      socket.end(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
    },
    persistPath: '/data/extensions.json',
    findGuest: async (id) => (guest && guest.id === id ? guest : null),
    idleStopMs: 60_000,
    openServiceRequest: service.openServiceRequest,
    holdService: (guestId) => {
      const entry = { guestId, released: false };
      holds.push(entry);
      return () => { entry.released = true; };
    },
    createViewerId: (() => { let n = 0; return () => `viewer-${++n}`; })(),
  });
  const port = await listen(server);
  cleanups.push(async () => {
    runtime.stop();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, runtime, service, holds, rejected };
};

describe('isSurfaceGuest', () => {
  test('needs enabled, approved, and a declared surface', () => {
    expect(isSurfaceGuest(surfaceGuest())).toBe(true);
    expect(isSurfaceGuest(surfaceGuest({ enabled: false }))).toBe(false);
    expect(isSurfaceGuest(surfaceGuest({ capabilityGrants: [] }))).toBe(false);
    expect(isSurfaceGuest(surfaceGuest({ service: { entry: 'service/main.js', runtime: 'host' } }))).toBe(false);
  });
});

describe('guest surface runtime', () => {
  test('refuses an upgrade for an unknown or surface-less extension', async () => {
    const { port, rejected } = await createHarness({ guest: surfaceGuest({ service: { entry: 'service/main.js', runtime: 'host' } }) });
    await expect(openViewer(port)).rejects.toThrow('upgrade 404');
    expect(rejected[0]).toMatchObject({ status: 404 });
  });

  test('refuses an upgrade without a UI session', async () => {
    const { port, rejected } = await createHarness({ rejectUpgradeAuth: true });
    await expect(openViewer(port)).rejects.toThrow('upgrade 401');
    expect(rejected[0]).toMatchObject({ status: 401 });
  });

  test('delivers frames one at a time per viewer and skips to the newest after an ack', async () => {
    const { port, service, holds } = await createHarness();
    const viewer = await openViewer(port);
    expect(await viewer.next()).toEqual({ type: 'hello', viewerId: 'viewer-1' });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    expect(holds).toEqual([{ guestId: 'sim', released: false }]);

    service.pushFrame({ seq: 1, bytes: Buffer.from('frame-1'), title: 'Home' });
    const meta = await viewer.next();
    expect(meta).toEqual({ type: 'frame', seq: 1, width: 320, height: 200, mime: 'image/png', bytes: 7, agentActive: false, title: 'Home' });
    expect((await viewer.next()).binary.toString()).toBe('frame-1');

    // Two more frames arrive before the viewer acknowledges: it gets only the newest.
    service.pushFrame({ seq: 2, bytes: Buffer.from('frame-2') });
    await settle();
    service.pushFrame({ seq: 3, bytes: Buffer.from('frame-3') });
    await settle();
    viewer.send({ type: 'ack', seq: 1 });
    expect(await viewer.next()).toMatchObject({ type: 'frame', seq: 3 });
    expect((await viewer.next()).binary.toString()).toBe('frame-3');

    viewer.ws.close();
    await viewer.closed;
    await settle();
    expect(holds[0].released).toBe(true);
    expect(service.callsTo(SURFACE_FRAME_PATH)[0].query).toEqual({ after: '0', wait: '25000' });
  });

  test('the first input takes control, is forwarded, and tells the service; release hands it back', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();

    const click = { type: 'pointer', action: 'down', x: 10, y: 20, button: 0, buttons: 1, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    viewer.send({ type: 'input', events: [click] });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    await settle();
    expect(runtime.userControls('sim')).toBe(true);
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].body).toEqual({ events: [click] });
    expect(service.callsTo(SURFACE_CONTROL_PATH).map((call) => call.body)).toEqual([{ controller: 'user', viewer: 'viewer-1' }]);

    viewer.send({ type: 'release' });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    await settle();
    expect(runtime.userControls('sim')).toBe(false);
    expect(service.callsTo(SURFACE_CONTROL_PATH).map((call) => call.body)).toEqual([{ controller: 'user', viewer: 'viewer-1' }, { controller: 'none' }]);
  });

  test('a second viewer cannot take control from the first and is told who has it', async () => {
    const { port, service } = await createHarness();
    const first = await openViewer(port);
    await first.next(); await first.next();
    const second = await openViewer(port);
    await second.next(); await second.next();

    const key = { type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    first.send({ type: 'input', events: [key] });
    expect(await first.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: false });

    second.send({ type: 'input', events: [key] });
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: false });
    await settle();
    expect(service.callsTo(SURFACE_INPUT_PATH)).toHaveLength(1);

    // The holder disconnecting releases control for everyone.
    first.ws.close();
    expect(await second.next()).toEqual({ type: 'control', controller: 'none', mine: false });
  });

  test('agent activity holds control until the hold expires, and the user always wins', async () => {
    const { port, runtime, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();

    // Not attached to a session: nothing to note, nothing thrown.
    runtime.noteAgentActivity('other');

    runtime.noteAgentActivity('sim');
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'agent', mine: false });
    expect(runtime.userControls('sim')).toBe(false);
    // A second action while already agent-held does not re-broadcast.
    runtime.noteAgentActivity('sim');

    const text = { type: 'text', text: 'hello' };
    viewer.send({ type: 'input', events: [text] });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    await settle();
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].body).toEqual({ events: [text] });
  });

  test('the agent hold expires back to nobody', async () => {
    const timers = [];
    const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    const service = createFakeService();
    const runtime = createGuestSurfaceRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket) => socket.destroy(),
      persistPath: '/data/extensions.json',
      findGuest: async () => surfaceGuest(),
      idleStopMs: 60_000,
      openServiceRequest: service.openServiceRequest,
      holdService: () => () => undefined,
      setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimer: () => undefined,
    });
    const port = await listen(server);
    cleanups.push(async () => { runtime.stop(); await new Promise((resolve) => server.close(resolve)); });
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    runtime.noteAgentActivity('sim');
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'agent' });
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
  });

  test('hovering over the picture does not take control; a click does', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'move', x: 5, y: 5, button: -1, buttons: 0, modifiers }] });
    await settle();
    expect(runtime.userControls('sim')).toBe(false);
    expect(service.callsTo(SURFACE_INPUT_PATH)).toHaveLength(0);

    runtime.noteAgentActivity('sim');
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'agent' });
    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'move', x: 6, y: 6, button: -1, buttons: 0, modifiers }] });
    await settle();
    expect(runtime.userControls('sim')).toBe(false);

    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'down', x: 6, y: 6, button: 0, buttons: 1, modifiers }] });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    // Now moves flow, as the holder's.
    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'move', x: 7, y: 7, button: -1, buttons: 0, modifiers }] });
    await settle();
    expect(service.callsTo(SURFACE_INPUT_PATH)).toHaveLength(2);
  });

  test('input batches reach the service in socket order even when one is slow', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await viewer.next(); // control
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers }] });
    viewer.send({ type: 'clipboard-read', id: 'c1' });
    await settle();
    expect(service.completed).toHaveLength(0);
    expect(service.callsTo(SURFACE_CLIPBOARD_PATH)).toHaveLength(0);
    open();
    expect(await viewer.next()).toEqual({ type: 'clipboard', id: 'c1', text: 'copied inside' });
    expect(service.completed.map((event) => event.key)).toEqual(['a', 'b']);
  });

  test('a session ended while the user held control never talks to the service again', async () => {
    const { port, service, runtime, holds } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'user', mine: true });
    await settle();
    const callsBefore = service.calls.length;

    // Approval withdrawn: the guest routes end the session; the socket closes after.
    runtime.endForGuest('sim');
    expect(await viewer.next()).toEqual({ type: 'ended', reason: 'extension-unavailable' });
    await viewer.closed;
    await settle();
    expect(service.calls.length).toBe(callsBefore);
    expect(holds[0].released).toBe(true);
  });

  test('the last viewer leaving while holding control tells the service it let go', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await viewer.next();
    await settle();
    viewer.ws.close();
    await viewer.closed;
    await settle();
    expect(service.callsTo(SURFACE_CONTROL_PATH).map((call) => call.body)).toEqual([{ controller: 'user', viewer: 'viewer-1' }, { controller: 'none' }]);
  });

  test('a queued input from before a hand-back does not take control again', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'user', mine: true });
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers }] });
    viewer.send({ type: 'release' });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    expect(runtime.userControls('sim')).toBe(false);
    open();
    await settle();
    await settle();
    expect(runtime.userControls('sim')).toBe(false);
    // B was typed before the release and still belonged to the holder: it is
    // not re-taken, and it is not delivered under nobody's control either.
    expect(service.completed.map((event) => event.key)).toEqual(['a']);
  });

  test('a queued input from a viewer that left never makes it the controller', async () => {
    const { port, service, runtime } = await createHarness();
    const first = await openViewer(port);
    await first.next(); await first.next();
    const second = await openViewer(port);
    await second.next(); await second.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    first.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await first.next();
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: false });
    first.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers }] });
    first.ws.close();
    expect(await second.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    open();
    await settle();
    await settle();
    expect(runtime.userControls('sim')).toBe(false);
    second.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers }] });
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    await settle();
    expect(service.completed.map((event) => event.key)).toEqual(['a', 'c']);
  });

  test('a deactivation while the closed panel\'s farewell is still queued cancels it', async () => {
    const { port, service, runtime, holds } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await viewer.next();
    await settle();
    viewer.ws.close();
    await viewer.closed;
    await settle();
    // The session is still registered: its final "none" waits behind the slow input.
    expect(runtime.sessionOf('sim')).not.toBeNull();
    const callsBefore = service.calls.length;
    runtime.endForGuest('sim');
    open();
    await settle();
    await settle();
    expect(service.calls.length).toBe(callsBefore);
    expect(runtime.sessionOf('sim')).toBeNull();
    expect(holds[0].released).toBe(true);
  });

  test('resize and clipboard reads round-trip through the service; clipboard needs control', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    viewer.send({ type: 'resize', width: 800, height: 600 });
    expect(await viewer.next()).toEqual({ type: 'resized', width: 640, height: 400 });
    expect(service.callsTo(SURFACE_RESIZE_PATH)[0].body).toEqual({ width: 800, height: 600 });
    viewer.send({ type: 'clipboard-read', id: 'c0' });
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'NOT_CONTROLLING' });
    expect(service.callsTo(SURFACE_CLIPBOARD_PATH)).toHaveLength(0);
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers: { ...modifiers, meta: true } }] });
    await viewer.next();
    viewer.send({ type: 'clipboard-read', id: 'c1' });
    expect(await viewer.next()).toEqual({ type: 'clipboard', id: 'c1', text: 'copied inside' });
  });

  test('a malformed viewer message is answered with an error, not a drop', async () => {
    const { port } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    viewer.ws.send('{"type":"input","events":[{"type":"pointer"}]}');
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'BAD_MESSAGE' });
  });

  test('a service that stops ends the session for every viewer; deactivation does too', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    service.fail(new GuestServiceError('gone', 'SERVICE_FAILED'));
    expect(await viewer.next()).toEqual({ type: 'ended', reason: 'service-stopped' });
    await viewer.closed;

    service.fail(null);
    const again = await openViewer(port);
    await again.next(); await again.next();
    runtime.endForGuest('sim');
    expect(await again.next()).toEqual({ type: 'ended', reason: 'extension-unavailable' });
    await again.closed;
    expect(runtime.sessionOf('sim')).toBeNull();
  });

  test('stamps input with the viewer and the service frame it last drew', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); // hello
    await viewer.next(); // control
    const click = { type: 'pointer', action: 'down', x: 1, y: 1, button: 0, buttons: 1, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };

    // Nothing drawn yet: frame 0.
    viewer.send({ type: 'input', events: [click] });
    await settle();
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].headers).toEqual({ 'x-surface-viewer': 'viewer-1', 'x-surface-frame-seq': '0' });
    expect(service.callsTo(SURFACE_CONTROL_PATH).at(-1).body).toEqual({ controller: 'user', viewer: 'viewer-1' });
    await viewer.next(); // control: mine

    service.pushFrame({ seq: 7, bytes: Buffer.from('frame-7') });
    await viewer.next();
    await viewer.next();
    // Sent but not yet drawn: input still counts as made on the old picture.
    viewer.send({ type: 'input', events: [click] });
    viewer.send({ type: 'ack', seq: 7 });
    viewer.send({ type: 'input', events: [click] });
    await settle();
    const stamped = service.callsTo(SURFACE_INPUT_PATH).map((call) => call.headers['x-surface-frame-seq']);
    expect(stamped).toEqual(['0', '0', '7']);

    expect(runtime.viewerHeaders('sim', 'viewer-1')).toEqual({ 'x-surface-viewer': 'viewer-1', 'x-surface-viewer-controls': '1', 'x-surface-frame-seq': '7' });
    expect(runtime.viewerHeaders('sim', 'viewer-2')).toBeNull();
    expect(runtime.viewerHeaders('other', 'viewer-1')).toBeNull();

    viewer.send({ type: 'release' });
    await settle();
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-viewer-controls']).toBe('0');
  });

  test('tells the viewer when the service refuses input made on an old picture', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();
    service.answerInputWith(409);
    viewer.send({ type: 'input', events: [{ type: 'text', text: 'hi' }] });
    await viewer.next(); // control: mine
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'INPUT_STALE' });
  });
});
