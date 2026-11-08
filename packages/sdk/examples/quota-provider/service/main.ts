// A usage provider for OpenChamber, written against the Teapot usage API
// (`../usage-server.ts`). OpenChamber asks it for usage the way it asks a
// built-in provider and draws the answer on the Usage page, in the header, in
// Work Status and on the phone. On every read it receives the credential
// OpenCode holds for the `teapot` provider, the one listed in the manifest and
// approved in the dialog, and nothing else of OpenCode's credential store.
import http from 'node:http';

import {
  QUOTA_PROVIDER_ERROR_MESSAGE_MAX,
  QUOTA_PROVIDER_PATH,
  readQuotaProviderRequest,
  type QuotaProviderCredential,
  type QuotaProviderResult,
  type QuotaProviderUsageData,
  type QuotaProviderWindow,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !serviceToken) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}
// Where the fake API listens. OpenChamber hands a service none of the host's
// environment, so in the app this is the fixed default; the example's own test
// points it at the server it started.
const USAGE_API = (process.env.TEAPOT_USAGE_URL ?? 'http://127.0.0.1:4569').replace(/\/+$/, '');
/** The OpenCode provider id the manifest lists; its credential arrives under this key. */
const PROVIDER = 'teapot';
const FIVE_HOURS = 5 * 3_600;
const ONE_WEEK = 7 * 24 * 3_600;

// The parts of the Teapot API's answer this service reads.
type TeapotWindow = { used: number; limit: number; resetsAt: number };
type TeapotUsage = { plan: string; windows: { fiveHour: TeapotWindow; weekly: TeapotWindow }; credits: { balanceUsd: number } };

/** The bearer the API takes: the key itself, or a browser login's access token. */
const bearerOf = (credential: QuotaProviderCredential): string => (credential.type === 'api' ? credential.key : credential.access);

const toWindow = (window: TeapotWindow, windowSeconds: number): QuotaProviderWindow => ({
  usedPercent: window.limit > 0 ? Math.min(100, (window.used / window.limit) * 100) : null,
  windowSeconds,
  resetAt: window.resetsAt,
  value: { kind: 'requests', count: window.used },
});

/** A built-in's failed result: the card shows `error` and keeps its last sample. */
const failure = (error: string): QuotaProviderUsageData => ({ ok: false, configured: true, error: error.slice(0, QUOTA_PROVIDER_ERROR_MESSAGE_MAX), usage: null });

/** One usage read with the credential OpenChamber handed over. */
const readUsage = async (credential: QuotaProviderCredential | undefined): Promise<QuotaProviderUsageData> => {
  // OpenChamber answers "not configured" itself when OpenCode holds no credential for a listed provider; this is the same answer, should the call still arrive.
  if (!credential) return { ok: false, configured: false, error: 'Not configured', usage: null };
  let response: Response;
  try {
    response = await fetch(`${USAGE_API}/api/usage`, { headers: { authorization: `Bearer ${bearerOf(credential)}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return failure(`Teapot did not answer at ${USAGE_API}: ${error instanceof Error ? error.message : String(error)}. Start the usage server from the example and refresh.`);
  }
  if (response.status === 401 || response.status === 403) {
    return failure('Teapot refused the key. Make a new one and store it for the teapot provider in Settings → Providers.');
  }
  if (!response.ok) return failure(`Teapot answered ${response.status}.`);
  let usage: TeapotUsage;
  try {
    usage = await response.json();
  } catch {
    return failure('Teapot answered with something other than JSON.');
  }
  return {
    ok: true,
    configured: true,
    planLabel: usage.plan,
    usage: {
      windows: {
        '5h': toWindow(usage.windows.fiveHour, FIVE_HOURS),
        weekly: toWindow(usage.windows.weekly, ONE_WEEK),
        credits_balance: { usedPercent: null, valueLabel: `$${usage.credits.balanceUsd.toFixed(2)}` },
      },
    },
  };
};

const send = (res: http.ServerResponse, status: number, body: QuotaProviderResult | { ok: true } | { error: string }): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${serviceToken}`) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== QUOTA_PROVIDER_PATH || req.method !== 'POST') {
    send(res, 404, { error: 'not-found' });
    return;
  }
  readBody(req).then(async (body) => {
    const request = readQuotaProviderRequest(body);
    if (!request) {
      send(res, 400, { error: 'not a usage call this service understands' });
      return;
    }
    send(res, 200, { ok: true, data: await readUsage(request.input.credentials[PROVIDER]) });
  }).catch(() => send(res, 500, { error: 'could not read the request' }));
});

server.listen(port, '127.0.0.1');
