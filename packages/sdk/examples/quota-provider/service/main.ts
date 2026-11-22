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
const USAGE_API = (process.env.TEAPOT_USAGE_URL ?? 'http://127.0.0.1:4569').replace(/\/+$/, '');
const PROVIDER = 'teapot';
const FIVE_HOURS = 5 * 3_600;
const ONE_WEEK = 7 * 24 * 3_600;

type TeapotWindow = { used: number; limit: number; resetsAt: number };
type TeapotUsage = { plan: string; windows: { fiveHour: TeapotWindow; weekly: TeapotWindow }; credits: { balanceUsd: number } };

const bearerOf = (credential: QuotaProviderCredential): string => (credential.type === 'api' ? credential.key : credential.access);

const toWindow = (window: TeapotWindow, windowSeconds: number): QuotaProviderWindow => ({
  usedPercent: window.limit > 0 ? Math.min(100, (window.used / window.limit) * 100) : null,
  windowSeconds,
  resetAt: window.resetsAt,
  value: { kind: 'requests', count: window.used },
});

const failure = (error: string): QuotaProviderUsageData => ({ ok: false, configured: true, error: error.slice(0, QUOTA_PROVIDER_ERROR_MESSAGE_MAX), usage: null });

const readUsage = async (credential: QuotaProviderCredential | undefined): Promise<QuotaProviderUsageData> => {
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
