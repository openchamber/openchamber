import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import type { JsonValue } from '../src/contract';
import { WAITS_CHECK_PATH, WAITS_START_PATH, WAIT_LABEL_MAX, type GuestWaitArgs, type GuestWaitCheckRequest, type GuestWaitStartRequest } from '../src/waits';
import { waitCheckOutcomeSchema, waitCheckResultSchema, waitStartResultSchema } from '../src/waits-schemas';

// Runs the checked-in service bundle the way OpenChamber does: a loopback
// port and bearer, a start per wait, then checks with the state it handed back.

const serviceEntry = fileURLToPath(new URL('../examples/wait-kit/service/main.js', import.meta.url));

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = Object(server.address());
    server.close(() => resolve(Number(port)));
  });
});

let service: ChildProcess;
let servicePort: number;
const serviceToken = randomBytes(16).toString('hex');
// A site that is down until the test says otherwise.
let siteStatus = 503;
let site: http.Server;
let siteUrl: string;

beforeAll(async () => {
  site = http.createServer((_req, res) => { res.writeHead(siteStatus); res.end(); });
  await new Promise<void>((resolve) => { site.listen(0, '127.0.0.1', () => resolve()); });
  siteUrl = `http://127.0.0.1:${Object(site.address()).port}/health`;
  servicePort = await freePort();
  service = spawn('node', [serviceEntry], {
    env: { PATH: process.env.PATH, OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: serviceToken },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // The host's own ready check: `GET /health` answers 200.
    const ready = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { authorization: `Bearer ${serviceToken}` } })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('the wait kit service did not become ready');
});

afterAll(() => {
  service?.kill();
  site?.close();
});

const post = (route: string, body: GuestWaitStartRequest | GuestWaitCheckRequest | { hello: string }, token = serviceToken) => fetch(`http://127.0.0.1:${servicePort}${route}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const start = async (type: string, args: GuestWaitArgs) => {
  const response = await post(WAITS_START_PATH, { v: 1, requestId: 'req-start', wait: { id: `wait_${type}`, type, args, session: { id: 'ses_1', directory: '/repo' } } });
  expect(response.status).toBe(200);
  return waitStartResultSchema.parse(await response.json());
};

const check = async (type: string, args: GuestWaitArgs, state: JsonValue) => {
  const response = await post(WAITS_CHECK_PATH, { v: 1, requestId: 'req-check', waits: [{ id: `wait_${type}`, type, args, state }] });
  expect(response.status).toBe(200);
  return waitCheckOutcomeSchema.parse(waitCheckResultSchema.parse(await response.json()).results[0]);
};

describe('wait kit example', () => {
  test('a timer fires once its seconds have passed', async () => {
    const started = await start('timer', { seconds: 1 });
    if (!started.ok) throw new Error(started.error);
    expect(started.label).toBe('1 s');
    expect(await check('timer', { seconds: 1 }, started.state ?? null)).toEqual({ id: 'wait_timer', fired: false });
    await new Promise((resolve) => { setTimeout(resolve, 1_100); });
    expect(await check('timer', { seconds: 1 }, started.state ?? null)).toEqual({ id: 'wait_timer', fired: true, summary: '1 seconds passed.' });
  });

  test('a URL fires once it answers 2xx, and keeps waiting while it does not', async () => {
    const started = await start('url-ready', { url: siteUrl });
    expect(started).toMatchObject({ ok: true, state: null });
    expect(await check('url-ready', { url: siteUrl }, null)).toEqual({ id: 'wait_url-ready', fired: false, state: { lastStatus: 503 } });
    siteStatus = 200;
    expect(await check('url-ready', { url: siteUrl }, { lastStatus: 503 })).toMatchObject({ fired: true, summary: `${siteUrl} answered HTTP 200.` });
  });

  test('keeps a long URL\'s label within what OpenChamber takes', async () => {
    const long = `https://preview-${'a'.repeat(120)}.example.com/api/health/readiness/deep`;
    const started = await start('url-ready', { url: long });
    expect(started).toMatchObject({ ok: true });
    if (started.ok) expect(started.label?.length).toBeLessThanOrEqual(WAIT_LABEL_MAX);
  });

  test('refuses what it cannot follow, a body it does not know, and a caller without the bearer', async () => {
    expect(await start('timer', { seconds: 0 })).toEqual({ ok: false, error: 'seconds must be a whole number from 1 to 86400' });
    expect(await start('url-ready', { url: 'ftp://example.com' })).toEqual({ ok: false, error: 'url must be an http or https address' });
    expect((await post(WAITS_START_PATH, { hello: 'world' })).status).toBe(400);
    expect((await post(WAITS_CHECK_PATH, { v: 1, requestId: 'x', waits: [] }, 'wrong')).status).toBe(401);
  });
});
