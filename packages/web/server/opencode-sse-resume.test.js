import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import express from 'express';
import path from 'path';

import { registerOpenCodeProxy } from './lib/opencode/proxy.js';

// A stand-in for OpenCode's event stream, with the wire format of packages/server/src/event-feed.ts:
// every event carries `id: <instance>:<sequence>`, a reconnect with Last-Event-ID replays what came
// after that id, and an id the feed does not hold (another instance, or one not yet produced) gets
// one `server.resync` frame carrying the head id. The real-OpenCode test below runs the same
// scenarios against the actual server when one is available.
const createFakeOpenCode = (instanceId = 'inst1') => {
  let currentInstance = instanceId;
  let sequence = 0;
  const ring = [];
  const live = new Set();
  const requests = [];

  const frame = (id, data) => `id: ${id}\ndata: ${data}\n\n`;

  const server = express();
  server.get('/api/event', (req, res) => {
    const lastEventId = req.headers['last-event-id'];
    requests.push({ lastEventId: lastEventId ?? null });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    if (lastEventId) {
      const index = ring.findIndex((entry) => entry.id === lastEventId);
      if (index === -1) {
        res.write(frame(`${currentInstance}:${sequence}`, '{"id":"evt_resync","type":"server.resync","data":{}}'));
      } else {
        for (const entry of ring.slice(index + 1)) res.write(frame(entry.id, entry.data));
      }
    }

    const subscriber = { res };
    live.add(subscriber);
    req.on('close', () => live.delete(subscriber));
  });

  let httpServer = null;

  return {
    requests,
    listen: () => new Promise((resolve) => {
      httpServer = server.listen(0, '127.0.0.1', () => resolve(httpServer));
    }),
    port: () => httpServer.address().port,
    close: () => closeServer(httpServer),
    liveCount: () => live.size,
    // Records and delivers one event. With no stream connected it is still kept for replay.
    publish(data) {
      sequence += 1;
      const id = `${currentInstance}:${sequence}`;
      ring.push({ id, data });
      for (const subscriber of live) subscriber.res.write(frame(id, data));
      return id;
    },
    // Ends every live stream abruptly, optionally after writing the start of a block.
    dropAll({ partialBlock = '' } = {}) {
      for (const subscriber of [...live]) {
        const destroy = () => subscriber.res.socket?.destroy();
        // The partial block has to reach the wire before the socket goes, or it is never seen.
        if (partialBlock) subscriber.res.write(partialBlock, destroy);
        else destroy();
      }
      live.clear();
    },
    // A new OpenCode instance: a new id prefix and an empty ring.
    restartInstance(nextInstanceId) {
      currentInstance = nextInstanceId;
      sequence = 0;
      ring.length = 0;
    },
  };
};

const closeServer = (server) => new Promise((resolve) => {
  if (!server) {
    resolve();
    return;
  }
  server.closeAllConnections?.();
  server.close(() => resolve());
});

const startProxy = async ({ upstreamPort, resumeWindowMs = 2_000, authHeaders = {} }) => {
  const app = express();
  registerOpenCodeProxy(app, {
    fs: {},
    os: {},
    path,
    OPEN_CODE_READY_GRACE_MS: 0,
    SSE_HEARTBEAT_INTERVAL_MS: 60_000,
    SSE_RECONNECT_DELAY_MS: 5,
    SSE_RECONNECT_MAX_DELAY_MS: 20,
    SSE_RESUME_WINDOW_MS: resumeWindowMs,
    getRuntime: () => ({
      openCodePort: upstreamPort,
      isOpenCodeReady: true,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
    }),
    getOpenCodeAuthHeaders: () => authHeaders,
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const typeOf = (data) => {
  try {
    return JSON.parse(data ?? '')?.type;
  } catch {
    return undefined;
  }
};

// What a browser's EventSource sees: each complete block, in order, with its id.
const openBrowserStream = async (url, headers = {}) => {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const blocks = [];
  let pending = '';
  let ended = false;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (block.startsWith(':')) continue;
        const id = block.match(/^id: (.*)$/m)?.[1];
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        blocks.push({ id, event, data, type: typeOf(data) });
      }
    }
    ended = true;
  })();
  return {
    blocks,
    ids: () => blocks.filter((block) => block.id !== undefined).map((block) => block.id),
    isEnded: () => ended,
    close: () => controller.abort(),
    pump,
  };
};

describe('OpenCode SSE resume through OpenChamber', () => {
  let upstream = null;
  let proxies = [];

  afterEach(async () => {
    for (const proxy of proxies) await closeServer(proxy);
    proxies = [];
    await closeServer(upstream?.httpServer);
    upstream = null;
  });

  const setup = async ({ resumeWindowMs } = {}) => {
    const fake = createFakeOpenCode();
    fake.httpServer = await fake.listen();
    upstream = fake;
    const proxy = await startProxy({ upstreamPort: fake.port(), resumeWindowMs });
    proxies.push(proxy);
    const base = `http://127.0.0.1:${proxy.address().port}`;
    return { fake, proxy, base };
  };

  it('reconnects to OpenCode after a clean drop and keeps the browser stream, with each missed event once and in order', async () => {
    const { fake, base } = await setup();
    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    fake.publish('{"n":3}');
    await waitFor(() => browser.ids().length === 3);

    // OpenCode drops between blocks while three events happen: the proxy reconnects with the last
    // id it forwarded and OpenCode replays the three, then the stream goes live again.
    fake.dropAll();
    fake.publish('{"n":4}');
    fake.publish('{"n":5}');
    fake.publish('{"n":6}');
    await waitFor(() => fake.requests.length === 2 && browser.ids().length === 6);
    fake.publish('{"n":7}');
    await waitFor(() => browser.ids().length === 7);

    expect(browser.ids()).toEqual(['inst1:1', 'inst1:2', 'inst1:3', 'inst1:4', 'inst1:5', 'inst1:6', 'inst1:7']);
    expect(browser.blocks.map((block) => block.data)).toEqual(
      ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}', '{"n":6}', '{"n":7}'],
    );
    expect(fake.requests.map((request) => request.lastEventId)).toEqual([null, 'inst1:3']);
    browser.close();
  });

  it('ends the browser stream when OpenCode is cut mid-block, and the browser resumes exactly from its last whole id', async () => {
    const { fake, base } = await setup();
    const first = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    fake.publish('{"n":3}');
    await waitFor(() => first.ids().length === 3);

    // The half of event 4 already reached the browser. The proxy cannot take that back, so it ends
    // the browser stream: the browser discards the half at end-of-stream, as EventSource does.
    fake.dropAll({ partialBlock: 'id: inst1:4\ndata: {"n":4' });
    fake.publish('{"n":4}');
    fake.publish('{"n":5}');
    await waitFor(() => first.isEnded());
    expect(first.ids()).toEqual(['inst1:1', 'inst1:2', 'inst1:3']);

    // EventSource reconnects with the last id it received, and the events after it come back whole.
    const second = await openBrowserStream(`${base}/api/global/event`, { 'Last-Event-ID': 'inst1:3' });
    await waitFor(() => second.ids().length === 2);
    fake.publish('{"n":6}');
    await waitFor(() => second.ids().length === 3);

    expect([...first.ids(), ...second.ids()]).toEqual(['inst1:1', 'inst1:2', 'inst1:3', 'inst1:4', 'inst1:5', 'inst1:6']);
    expect(second.blocks.map((block) => block.data)).toEqual(['{"n":4}', '{"n":5}', '{"n":6}']);
    expect(fake.requests.at(-1).lastEventId).toBe('inst1:3');
    second.close();
  });

  it('passes a server.resync frame through to the browser, and a later reconnect resumes from its head id', async () => {
    const { fake, base } = await setup();
    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    await waitFor(() => browser.ids().length === 2);

    // A new OpenCode instance: the cursor it is handed belongs to another instance, so it resyncs
    // with its own head id (inst2:0, nothing published yet).
    fake.restartInstance('inst2');
    fake.dropAll();
    await waitFor(() => browser.blocks.some((block) => block.event === undefined && block.data?.includes('server.resync')));
    expect(fake.requests.map((request) => request.lastEventId)).toEqual([null, 'inst1:2']);
    expect(browser.blocks.find((block) => block.type === 'server.resync')).toEqual({
      id: 'inst2:0',
      event: undefined,
      data: '{"id":"evt_resync","type":"server.resync","data":{}}',
      type: 'server.resync',
    });

    // The cursor is now the head id, so a reconnect resumes from it rather than from nothing.
    fake.dropAll();
    await waitFor(() => fake.requests.length === 3);
    expect(fake.requests[2].lastEventId).toBe('inst2:0');

    fake.publish('{"n":3}');
    await waitFor(() => browser.ids().includes('inst2:1'));
    browser.close();
  });

  it('keeps a browser stream through an OpenCode restart and resumes it from the same Last-Event-ID on a successor OpenChamber', async () => {
    const { fake, proxy, base } = await setup();
    const successorProxy = await startProxy({ upstreamPort: fake.port() });
    proxies.push(successorProxy);
    const successorBase = `http://127.0.0.1:${successorProxy.address().port}`;

    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    fake.publish('{"n":3}');
    await waitFor(() => browser.ids().length === 3);

    // The first OpenChamber goes away. Events keep arriving on OpenCode while nothing serves the browser.
    browser.close();
    await closeServer(proxy);
    proxies = proxies.filter((entry) => entry !== proxy);
    fake.publish('{"n":4}');
    fake.publish('{"n":5}');

    // The browser's EventSource reconnects to the successor with the last id it received.
    const resumed = await openBrowserStream(`${successorBase}/api/global/event`, { 'Last-Event-ID': 'inst1:3' });
    await waitFor(() => resumed.ids().length === 2);
    fake.publish('{"n":6}');
    await waitFor(() => resumed.ids().length === 3);

    expect(resumed.ids()).toEqual(['inst1:4', 'inst1:5', 'inst1:6']);
    expect(resumed.blocks.map((block) => block.data)).toEqual(['{"n":4}', '{"n":5}', '{"n":6}']);
    expect(fake.requests.at(-1).lastEventId).toBe('inst1:3');
    resumed.close();
  });

  it('ends a browser stream once OpenCode has been gone longer than the resume window', async () => {
    const { fake, base } = await setup({ resumeWindowMs: 150 });
    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    await waitFor(() => browser.ids().length === 1);

    await closeServer(fake.httpServer);
    fake.httpServer = null;
    upstream = null;

    await waitFor(() => browser.isEnded(), 3_000);
    expect(browser.ids()).toEqual(['inst1:1']);
  });

});

// The real OpenCode server, from a checkout of developing-today/opencode at dcf98976aa or later (the
// commit that emits `id: <instance>:<seq>` and replays on Last-Event-ID). OPENCODE_RESUME_DRIVER is a
// small entry file inside that checkout's packages/cli/src that starts ServerProcess.run on the port in
// OC_PORT; the suite is skipped without it. The driver lives in the OpenCode tree, because it has to
// resolve that tree's dependencies.
const upstreamDriver = process.env.OPENCODE_RESUME_DRIVER;
const upstreamPassword = 'resume-test-password';
const upstreamAuth = `Basic ${Buffer.from(`opencode:${upstreamPassword}`).toString('base64')}`;

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// Which port one start attempt binds. The initial start takes the port
// already chosen for it, and a fresh port on each retry: a probed port is
// released before the driver binds it, so another process can hold it by
// the time a retry runs. A restart never takes a fresh port, on any
// attempt: the proxy built for the first start captured the port by
// value, so a restarted driver that comes up on a new port leaves the
// proxy, and every stream through it, pointing at a port nothing serves.
const attemptPort = async ({ attempt, currentPort, reusePort, freshPort }) => {
  if (currentPort !== null && (reusePort || attempt === 1)) return currentPort;
  return freshPort();
};

describe('upstream start port choice', () => {
  it('keeps the chosen port on the first attempt and takes a fresh port per retry on the initial start', async () => {
    let next = 41_000;
    const freshPort = async () => { next += 1; return next; };
    expect(await attemptPort({ attempt: 1, currentPort: null, reusePort: false, freshPort })).toBe(41_001);
    expect(await attemptPort({ attempt: 1, currentPort: 40_000, reusePort: false, freshPort })).toBe(40_000);
    expect(await attemptPort({ attempt: 2, currentPort: 40_000, reusePort: false, freshPort })).toBe(41_002);
    expect(await attemptPort({ attempt: 5, currentPort: 41_002, reusePort: false, freshPort })).toBe(41_003);
  });

  it('keeps the proxy port on every restart retry, so a retried restart can only recover on that port or fail at the start bound', async () => {
    const freshPort = async () => { throw new Error('a restart retry must not probe a new port'); };
    for (const attempt of [1, 2, 3, 4, 5]) {
      expect(await attemptPort({ attempt, currentPort: 40_000, reusePort: true, freshPort })).toBe(40_000);
    }
  });
});

describe.skipIf(!upstreamDriver)('against a real OpenCode that emits and replays SSE ids (OPENCODE_RESUME_DRIVER)', () => {
  let tempHome = null;
  let upstreamChild = null;
  let upstreamPort = null;
  let proxyServer = null;
  const streams = [];

  // The driver takes its port through OC_PORT, so the port has to be chosen before it starts.
  // A probed port is released before the driver binds it, and another process can take it in
  // between (#685, the race #666 fixed for the gatekeeper suite): the driver then exits before
  // it listens, or the readiness loop waits on a stranger's listener. The start below retries
  // with a fresh port when the child exits before listening, up to five attempts. A child that
  // stays up but never listens is not retried, and the fifth early exit throws with the child's
  // own output, so a real startup failure still fails loudly after the bound. The restart in
  // the test below passes reusePort: its retries stay on the port its proxy was built with
  // (attemptPort above), bounded by the same five attempts and the same loud throw.
  const startUpstream = async ({ reusePort = false } = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      upstreamPort = await attemptPort({ attempt, currentPort: upstreamPort, reusePort, freshPort: freePort });
      let childOutput = '';
      const child = spawn('bun', ['run', upstreamDriver], {
        cwd: path.dirname(upstreamDriver),
        env: {
          ...process.env,
          HOME: tempHome,
          XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
          XDG_CONFIG_HOME: path.join(tempHome, '.config'),
          XDG_STATE_HOME: path.join(tempHome, '.local', 'state'),
          OC_PORT: String(upstreamPort),
          OPENCODE_PASSWORD: upstreamPassword,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Both pipes are read, always: a full pipe blocks the child, and the kept tail is what
      // the failure errors below report.
      const keep = (chunk) => { childOutput = `${childOutput}${chunk}`.slice(-4_000); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const deadline = Date.now() + 120_000;
      let exited = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) { exited = true; break; }
        try {
          const response = await fetch(`http://127.0.0.1:${upstreamPort}/api/info`, { headers: { Authorization: upstreamAuth } });
          if (response.ok && child.exitCode === null) return child;
        } catch {
          // Not listening yet.
        }
        await sleep(250);
      }
      if (!exited) {
        child.kill('SIGKILL');
        throw new Error(`OpenCode did not start in time:\n${childOutput}`);
      }
      if (attempt >= 5) throw new Error(`OpenCode exited before it listened:\n${childOutput}`);
    }
  };

  const stopUpstream = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });

  const createSession = async (title) => {
    const response = await fetch(`http://127.0.0.1:${upstreamPort}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: upstreamAuth },
      body: JSON.stringify({ title }),
    });
    expect(response.status).toBe(200);
    await response.text();
  };

  const openStream = async (url, headers) => {
    const stream = await openBrowserStream(url, headers);
    streams.push(stream);
    return stream;
  };

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await closeServer(proxyServer);
    proxyServer = null;
    await stopUpstream(upstreamChild);
    upstreamChild = null;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it('replays exactly the missed events on resume, and resyncs a browser stream held across an OpenCode restart', async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'oc-resume-'));
    upstreamPort = await freePort();
    upstreamChild = await startUpstream();
    const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

    proxyServer = await startProxy({
      upstreamPort,
      resumeWindowMs: 90_000,
      authHeaders: { Authorization: upstreamAuth },
    });
    const proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;

    // The control stream reads OpenCode directly and never disconnects: the ground truth for every event.
    const control = await openStream(`${upstreamBase}/api/event`, { Authorization: upstreamAuth });
    await waitFor(() => control.blocks.some((block) => block.type === 'server.connected'));
    const browser = await openStream(`${proxyBase}/api/global/event`);
    await waitFor(() => browser.blocks.some((block) => block.type === 'server.connected'));

    await createSession('Replay one');
    await createSession('Replay two');
    await waitFor(() => browser.blocks.filter((block) => block.type === 'session.created').length === 2);
    const cursor = browser.ids().at(-1);
    expect(cursor).toMatch(/^[0-9a-f-]{36}:\d+$/);

    // The browser goes away; two more sessions are created while nothing is listening for it.
    browser.close();
    await createSession('Missed one');
    await createSession('Missed two');
    await waitFor(() => control.blocks.filter((block) => block.type === 'session.created').length === 4);

    const expected = control.blocks.filter((block) => block.id !== undefined);
    const cut = expected.findIndex((block) => block.id === cursor);
    const missed = expected.slice(cut + 1);
    expect(missed.length).toBeGreaterThanOrEqual(2);

    // EventSource reconnects with the last id it received: exactly the missed events come back, in order.
    const resumed = await openStream(`${proxyBase}/api/global/event`, { 'Last-Event-ID': cursor });
    await waitFor(() => resumed.ids().length === missed.length);
    expect(resumed.ids()).toEqual(missed.map((block) => block.id));
    expect(resumed.blocks.filter((block) => block.id !== undefined).map((block) => block.type))
      .toEqual(missed.map((block) => block.type));

    // The browser stream stays open across an OpenCode restart. The proxy keeps reconnecting with the
    // cursor; the new OpenCode, a new instance, answers with a server.resync carrying its own head id.
    const oldInstance = cursor.split(':')[0];
    await stopUpstream(upstreamChild);
    upstreamChild = await startUpstream({ reusePort: true });
    await waitFor(() => resumed.blocks.some((block) => block.type === 'server.resync'), 90_000);
    const resync = resumed.blocks.find((block) => block.type === 'server.resync');
    expect(resync.id).toMatch(/^[0-9a-f-]{36}:\d+$/);
    expect(resync.id.split(':')[0]).not.toBe(oldInstance);

    // Live again after the resync: a new session reaches the held browser stream under the new instance.
    await createSession('After restart');
    await waitFor(() => resumed.blocks.some((block) => block.type === 'session.created' && block.id?.startsWith(`${resync.id.split(':')[0]}:`)), 30_000);
  }, 300_000);
});
