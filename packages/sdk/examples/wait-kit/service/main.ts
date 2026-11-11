// A service that offers agents two waits: a timer, and a URL that starts
// answering. OpenChamber keeps every wait and its state and asks this service
// on each type's interval whether it fired, so the service keeps nothing and
// may be stopped between checks. Runs under the app's Node runtime on
// 127.0.0.1, reachable only through the host.
import http from 'node:http';

import {
  WAITS_CHECK_PATH,
  WAITS_START_PATH,
  WAIT_LABEL_MAX,
  readWaitCheckRequest,
  readWaitStartRequest,
  type GuestWaitArgs,
  type GuestWaitCheckOutcome,
  type GuestWaitCheckResult,
  type GuestWaitStartResult,
  type JsonValue,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const MAX_SECONDS = 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 5_000;

type Answer = GuestWaitStartResult | GuestWaitCheckResult | { error: string };

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

const dueOf = (state: JsonValue): number | null => {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
  return typeof state.due === 'number' ? state.due : null;
};

/** Takes a new wait, or says what the agent should change. */
const start = (type: string, args: GuestWaitArgs): GuestWaitStartResult => {
  if (type === 'timer') {
    const seconds = Number(args.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
      return { ok: false, error: `seconds must be a whole number from 1 to ${MAX_SECONDS}` };
    }
    return { ok: true, state: { due: Date.now() + seconds * 1_000 }, label: `${seconds} s` };
  }
  if (type === 'url-ready') {
    const address = String(args.url);
    if (!URL.canParse(address) || !['http:', 'https:'].includes(new URL(address).protocol)) {
      return { ok: false, error: 'url must be an http or https address' };
    }
    const url = new URL(address);
    return { ok: true, state: null, label: `${url.host}${url.pathname === '/' ? '' : url.pathname}`.slice(0, WAIT_LABEL_MAX) };
  }
  return { ok: false, error: `this service has no wait "${type}"` };
};

/** Whether one wait fired. A URL that cannot be reached yet keeps waiting. */
const check = async (wait: { id: string; type: string; args: GuestWaitArgs; state: JsonValue }): Promise<GuestWaitCheckOutcome> => {
  if (wait.type === 'timer') {
    const due = dueOf(wait.state);
    if (due !== null && Date.now() >= due) return { id: wait.id, fired: true, summary: `${wait.args.seconds} seconds passed.` };
    return { id: wait.id, fired: false };
  }
  const expected = typeof wait.args.status === 'number' ? wait.args.status : null;
  try {
    const response = await fetch(String(wait.args.url), { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await response.body?.cancel();
    const ready = expected === null ? response.status >= 200 && response.status < 300 : response.status === expected;
    if (ready) return { id: wait.id, fired: true, summary: `${String(wait.args.url).slice(0, 1_000)} answered HTTP ${response.status}.` };
    return { id: wait.id, fired: false, state: { lastStatus: response.status } };
  } catch (error) {
    return { id: wait.id, fired: false, state: { lastError: error instanceof Error ? error.message : String(error) } };
  }
};

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  // OpenChamber waits for this before it sends anything.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method !== 'POST' || (url.pathname !== WAITS_START_PATH && url.pathname !== WAITS_CHECK_PATH)) {
    json(res, 404, { error: 'not-found' });
    return;
  }
  void readBody(req).then(async (body) => {
    if (url.pathname === WAITS_START_PATH) {
      const request = readWaitStartRequest(body);
      if (!request) {
        json(res, 400, { error: 'not a wait this service understands' });
        return;
      }
      json(res, 200, start(request.wait.type, request.wait.args));
      return;
    }
    const request = readWaitCheckRequest(body);
    if (!request) {
      json(res, 400, { error: 'not a check this service understands' });
      return;
    }
    json(res, 200, { results: await Promise.all(request.waits.map(check)) });
  }).catch(() => json(res, 500, { error: 'could not read the request' }));
});

server.listen(port, '127.0.0.1');
