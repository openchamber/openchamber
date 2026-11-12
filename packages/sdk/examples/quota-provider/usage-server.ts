// A fake usage API for the Teapot Usage example: a loopback HTTP server that
// answers one account's plan, its two rolling windows and its credit balance
// behind one bearer. Run it with Bun, store the same key for the `teapot`
// provider in OpenCode, and the card fills on the Usage page. It is a test
// double for the role's contract; everything it keeps is lost when it stops.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type UsageServerState = {
  plan: string;
  /** The rolling windows as the API counts them: requests used of the allowance, and when the window ends. */
  fiveHour: { used: number; limit: number; resetsAt: number };
  weekly: { used: number; limit: number; resetsAt: number };
  /** Prepaid credit in USD. */
  creditsUsd: number;
};

/** What the API answers: the account's usage, or why it refused. */
type UsageAnswer =
  | { plan: string; windows: { fiveHour: UsageServerState['fiveHour']; weekly: UsageServerState['weekly'] }; credits: { balanceUsd: number } }
  | { error: string };

export type UsageServer = {
  /** `http://127.0.0.1:<port>`: what the service calls. */
  origin: string;
  token: string;
  state: UsageServerState;
  close: () => Promise<void>;
};

const HOUR = 3_600_000;

/** `server.address()` is a string for a pipe; this server listens on a TCP port and gets the bound address. */
const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo => value !== null && String(value) !== value;

/** A fresh account: a quarter of the five-hour window and most of the week spent, some credit left. */
const createUsageServerState = (now: number): UsageServerState => ({
  plan: 'Pro',
  fiveHour: { used: 120, limit: 500, resetsAt: now + 3 * HOUR + 17 * 60_000 },
  weekly: { used: 4_100, limit: 5_000, resetsAt: now + 2 * 24 * HOUR },
  creditsUsd: 12.5,
});

export const startUsageServer = ({ token = 'demo', port = 0, log = (): void => {}, now = Date.now }: { token?: string; port?: number; log?: (line: string) => void; now?: () => number } = {}): Promise<UsageServer> => new Promise((resolve, reject) => {
  const state = createUsageServerState(now());
  const server = http.createServer((req, res) => {
    const send = (status: number, body: UsageAnswer) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/api/usage') {
      send(404, { error: 'not found' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      log('[refused] a request with a key this server does not know');
      send(401, { error: 'invalid key' });
      return;
    }
    log('[usage] read');
    send(200, {
      plan: state.plan,
      windows: {
        fiveHour: { ...state.fiveHour },
        weekly: { ...state.weekly },
      },
      credits: { balanceUsd: state.creditsUsd },
    });
  });
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = isAddressInfo(address) ? address.port : port;
    resolve({
      origin: `http://127.0.0.1:${boundPort}`,
      token,
      state,
      close: () => new Promise((done) => { server.close(() => done()); }),
    });
  });
});

if (import.meta.main) {
  const token = process.env.TEAPOT_TOKEN || 'demo';
  const server = await startUsageServer({ token, port: Number(process.env.TEAPOT_PORT || 4569), log: (line) => console.log(line) });
  console.log(`Teapot usage API listening on ${server.origin}`);
  console.log(`Store the key "${token}" for the provider "teapot" in OpenCode (Settings → Providers → Add custom provider, or \`opencode auth login\` → Other → teapot); the Teapot Usage card then reads it.`);
  console.log(`A key this server does not know is refused with 401: restart it with TEAPOT_TOKEN=<other> to see the card report that.`);
}
