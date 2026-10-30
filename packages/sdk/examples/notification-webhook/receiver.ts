// A receiver for the Webhook Notifier example: a loopback HTTP server that
// accepts one bearer, says who it belongs to on `/whoami`, and prints every
// notification posted to `/notify`. Run it with Bun, connect its address and
// token on the Webhook card in Settings → Integrations, and watch the lines.
import http from 'node:http';

/** A notification as the Webhook Notifier posts it: OpenChamber's notification fields plus the account it was sent as. */
export type ReceivedNotification = { kind?: string; title?: string; body?: string; account?: { id: string; login: string | null } | null };

export type Receiver = {
  origin: string;
  token: string;
  /** Every `/notify` body the receiver accepted, oldest first. */
  received: ReceivedNotification[];
  close: () => Promise<void>;
};

type Answer = { ok: true } | { error: string } | { id: string; login: string; name: string };

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

export const startReceiver = ({ token = 'demo', port = 0, log = (): void => {} }: { token?: string; port?: number; log?: (line: string) => void } = {}): Promise<Receiver> => new Promise((resolve, reject) => {
  const received: ReceivedNotification[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorized = req.headers.authorization === `Bearer ${token}`;
    const json = (status: number, body: Answer) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/') {
      json(200, { ok: true });
      return;
    }
    if (!authorized) {
      json(401, { error: 'unauthorized' });
      return;
    }
    if (url.pathname === '/whoami') {
      json(200, { id: 'webhook', login: 'receiver', name: 'Webhook receiver' });
      return;
    }
    if (url.pathname === '/notify' && req.method === 'POST') {
      void readBody(req).then((body) => {
        let notification: ReceivedNotification | null;
        try {
          notification = JSON.parse(body);
        } catch {
          json(400, { error: 'not JSON' });
          return;
        }
        if (Object(notification) !== notification || notification === null) {
          json(400, { error: 'not a notification' });
          return;
        }
        received.push(notification);
        log(`[${notification.kind}] ${notification.title}${notification.body ? `: ${notification.body}` : ''}`);
        json(200, { ok: true });
      });
      return;
    }
    json(404, { error: 'not-found' });
  });
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    resolve({
      origin: `http://127.0.0.1:${boundPort}`,
      token,
      received,
      close: () => new Promise((done) => { server.close(() => done()); }),
    });
  });
});

if (import.meta.main) {
  const token = process.env.WEBHOOK_TOKEN || 'demo';
  const receiver = await startReceiver({ token, port: Number(process.env.WEBHOOK_PORT || 4567), log: (line) => console.log(line) });
  console.log(`Webhook receiver listening on ${receiver.origin}`);
  console.log(`Connect it on the Webhook card in Settings → Integrations with the address above and the token "${token}".`);
}
