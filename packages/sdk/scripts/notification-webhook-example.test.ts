import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { startReceiver, type Receiver } from '../examples/notification-webhook/receiver';
import { notificationsProviderSchemasV1 as schemas } from '../src/service-provider-schemas';
import {
  NOTIFICATIONS_OUTBOUND_PATH,
  NOTIFICATIONS_PROVIDER_PATH,
  OPENCHAMBER_HOST_CALLBACK_URL,
  type GuestNotification,
  type NotificationsProviderMethod,
} from '../src/service-providers';

// Runs the checked-in service bundle the way OpenChamber does: a loopback
// port and bearer, a callback listener that plays OpenChamber's outbound proxy
// (handle → receiver origin and token), and the example's receiver behind it.

const serviceEntry = fileURLToPath(new URL('../examples/notification-webhook/service/main.js', import.meta.url));
const PROVIDER = 'ext-notification-webhook';

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = Object(server.address());
    server.close(() => resolve(Number(port)));
  });
});

let receiver: Receiver;
let service: ChildProcess;
let servicePort: number;
const serviceToken = randomBytes(16).toString('hex');
const handles = new Map<string, { origin: string; token: string | null }>();
let callback: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  receiver = await startReceiver({ token: 'demo' });
  callback = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const grant = handles.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (new URL(request.url).pathname !== NOTIFICATIONS_OUTBOUND_PATH || !grant) {
        return Response.json({ error: { message: 'Unknown handle', code: 'HANDLE_UNKNOWN' } }, { status: 403 });
      }
      const outbound = schemas.outboundRequest.safeParse(await request.json());
      if (!outbound.success) return Response.json({ error: { message: 'Malformed request', code: 'BAD_REQUEST' } }, { status: 400 });
      const url = new URL(outbound.data.path, grant.origin);
      if (url.origin !== grant.origin) return Response.json({ error: { message: 'Off the instance', code: 'OFF_ORIGIN' } }, { status: 403 });
      const headers = new Headers(outbound.data.headers);
      if (grant.token) headers.set('authorization', `Bearer ${grant.token}`);
      const answer = await fetch(url, { method: outbound.data.method, headers, body: outbound.data.body, redirect: 'manual' });
      return Response.json({ status: answer.status, headers: { 'content-type': answer.headers.get('content-type') ?? '' }, body: await answer.text() });
    },
  });
  servicePort = await freePort();
  service = spawn('node', [serviceEntry], {
    env: {
      PATH: process.env.PATH,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      [OPENCHAMBER_HOST_CALLBACK_URL]: `http://127.0.0.1:${callback.port}`,
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { authorization: `Bearer ${serviceToken}` } })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('the webhook notifier service did not become ready');
});

afterAll(async () => {
  service?.kill();
  callback?.stop(true);
  await receiver?.close();
});

let requests = 0;
/** One forwarded call with a fresh handle, the way OpenChamber mints one per call. */
const call = async (method: NotificationsProviderMethod, { token, account = null, input = {} }: { token: string | null; account?: { id: string; login: string | null } | null; input?: unknown }) => {
  const handle = randomBytes(16).toString('base64url');
  handles.set(handle, { origin: receiver.origin, token });
  try {
    const response = await fetch(`http://127.0.0.1:${servicePort}${NOTIFICATIONS_PROVIDER_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, requestId: `req-${requests += 1}`, method, provider: PROVIDER, session: { instance: receiver.origin, handle, account }, input }),
    });
    expect(response.status).toBe(200);
    return schemas.envelope.parse(await response.json());
  } finally {
    handles.delete(handle);
  }
};

describe('webhook notifier example', () => {
  test('probes the receiver without a token and verifies who a token belongs to', async () => {
    expect(await call('auth.probe', { token: null })).toEqual({ ok: true, data: { supported: true } });
    const verified = await call('auth.verify', { token: 'demo' });
    expect(verified.ok && schemas.data['auth.verify'].parse(verified.data)).toEqual({ account: { id: 'webhook', login: 'receiver', name: 'Webhook receiver' } });
    const refused = await call('auth.verify', { token: 'wrong' });
    expect(refused).toMatchObject({ ok: false, error: { status: 401 } });
  });

  test('delivers a notification to the receiver as the account, with the token OpenChamber added', async () => {
    const notification: GuestNotification = {
      kind: 'ready', title: 'Agent response is ready', body: 'Fix the parser: Done.', tag: 'ready-ses_1', at: 1_700_000_000_000,
      sessionId: 'ses_1', sessionName: 'Fix the parser', directory: '/repo', url: '/?session=ses_1',
    };
    const delivered = await call('notify', { token: 'demo', account: { id: 'webhook', login: 'receiver' }, input: { notification } });
    expect(delivered).toEqual({ ok: true, data: { delivered: true } });
    expect(receiver.received).toEqual([{ ...notification, account: { id: 'webhook', login: 'receiver' } }]);
    const refused = await call('notify', { token: 'stale', account: { id: 'webhook', login: 'receiver' }, input: { notification } });
    expect(refused).toMatchObject({ ok: false, error: { status: 401 } });
    expect(receiver.received).toHaveLength(1);
  });

  test('refuses a body that is not a notifications call, and a caller without the bearer', async () => {
    const junk = await fetch(`http://127.0.0.1:${servicePort}${NOTIFICATIONS_PROVIDER_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }, body: '{"hello":"world"}',
    });
    expect(junk.status).toBe(400);
    const anonymous = await fetch(`http://127.0.0.1:${servicePort}${NOTIFICATIONS_PROVIDER_PATH}`, { method: 'POST', body: '{}' });
    expect(anonymous.status).toBe(401);
  });
});
