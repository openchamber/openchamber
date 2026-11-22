import http from 'node:http';

import {
  NOTIFICATIONS_PROVIDER_ERROR_MESSAGE_MAX,
  NOTIFICATIONS_PROVIDER_PATH,
  NotificationsOutboundError,
  createNotificationsOutbound,
  readNotificationsProviderRequest,
  type GuestNotification,
  type NotificationsAccountData,
  type NotificationsProbeData,
  type NotificationsProviderResult,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !serviceToken) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}
const outbound = createNotificationsOutbound({ env: process.env });

type Answer = NotificationsProviderResult | { ok: true } | { error: string };

const json = (res: http.ServerResponse, status: number, body: Answer): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

type Failure = Extract<NotificationsProviderResult, { ok: false }>;

const failure = (message: string, status?: number): Failure => {
  // OpenChamber rejects an error message over this cap as "not a notifications
  // answer", which hides the real failure, so every message is bounded here, at
  // the one place a failure is built, including the relayed exception text.
  const error: Failure['error'] = { message: message.slice(0, NOTIFICATIONS_PROVIDER_ERROR_MESSAGE_MAX) || 'Unexpected failure' };
  if (status !== undefined) error.status = status;
  return { ok: false, error };
};

class RelayFailure extends Error {
  readonly result: NotificationsProviderResult;
  constructor(message: string) {
    super(message);
    this.result = failure(message);
  }
}

const relay = async (handle: string, request: Parameters<typeof outbound.request>[1]) => {
  try {
    return await outbound.request(handle, request);
  } catch (error) {
    if (error instanceof NotificationsOutboundError) throw new RelayFailure(`OpenChamber refused the request: ${error.message}`);
    throw new RelayFailure(error instanceof Error ? error.message : String(error));
  }
};

const whoami = async (handle: string): Promise<NotificationsProviderResult> => {
  const answer = await relay(handle, { method: 'GET', path: '/whoami' });
  if (answer.status === 401) return failure('The receiver refused the token.', 401);
  if (answer.status !== 200) return failure(`The receiver answered ${answer.status} to /whoami.`, answer.status);
  let who: { id?: string; login?: string; name?: string };
  try {
    who = Object(JSON.parse(answer.body));
  } catch {
    return failure('The receiver answered /whoami with something other than JSON.');
  }
  const { id, login, name } = who;
  if (String(id) !== id || String(login) !== login) return failure('The receiver did not say who the token belongs to.');
  const account: NotificationsAccountData['account'] = { id, login };
  if (String(name) === name && name.length > 0) account.name = name;
  return { ok: true, data: { account } };
};

const deliver = async (handle: string, notification: GuestNotification, account: { id: string; login: string | null } | null): Promise<NotificationsProviderResult> => {
  const answer = await relay(handle, {
    method: 'POST',
    path: '/notify',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...notification, account }),
  });
  if (answer.status === 401) return failure('The receiver refused the token.', 401);
  if (answer.status < 200 || answer.status >= 300) return failure(`The receiver answered ${answer.status}.`, answer.status);
  return { ok: true, data: { delivered: true } };
};

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${serviceToken}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === NOTIFICATIONS_PROVIDER_PATH && req.method === 'POST') {
    void readBody(req).then(async (body) => {
      const request = readNotificationsProviderRequest(body);
      if (!request) {
        json(res, 400, failure('not a notifications call this service understands'));
        return;
      }
      const { method, session, input } = request;
      try {
        if (method === 'auth.probe') {
          const answer = await relay(session.handle, { method: 'GET', path: '/' });
          const probe: NotificationsProbeData = { supported: answer.status < 500 };
          if (!probe.supported) probe.message = `The receiver answered ${answer.status}.`;
          json(res, 200, { ok: true, data: probe });
          return;
        }
        if (method === 'auth.verify') {
          json(res, 200, await whoami(session.handle));
          return;
        }
        // SAFETY: on `notify` OpenChamber puts the notification under `input.notification`
        // (`notificationsProviderSchemasV1.input.notify`); the service reads it under that shape.
        const { notification } = input as { notification?: GuestNotification };
        if (!notification) {
          json(res, 200, failure('notify needs a notification'));
          return;
        }
        json(res, 200, await deliver(session.handle, notification, session.account));
      } catch (error) {
        json(res, 200, error instanceof RelayFailure ? error.result : failure(error instanceof Error ? error.message : String(error)));
      }
    }).catch(() => json(res, 500, failure('could not read the request')));
    return;
  }
  json(res, 404, { error: 'not-found' });
});

server.listen(port, '127.0.0.1');
