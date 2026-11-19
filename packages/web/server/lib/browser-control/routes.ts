import type { createBrowserControlBroker } from './broker.js';
import type { BrowserControlApp, BrowserControlHandler } from './http-contracts.js';

interface ResultBody {
  requestId?: unknown;
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

const isResultBody = (value: unknown): value is ResultBody => Boolean(value) && typeof value === 'object';
const isString = (value: unknown): value is string => typeof value === 'string';

export function registerBrowserControlRoutes(app: Pick<BrowserControlApp, 'post'>, { express, broker }: {
  express: { json: (options: { limit: string }) => BrowserControlHandler };
  broker: Pick<ReturnType<typeof createBrowserControlBroker>, 'claim' | 'resolve'>;
}) {
  app.post('/api/browser-control/claim', express.json({ limit: '4kb' }), (req, res) => {
    const body: unknown = req.body;
    const requestId = isResultBody(body) && isString(body.requestId) ? body.requestId.trim() : '';
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    res.json({ granted: broker.claim(requestId) });
  });

  app.post('/api/browser-control/result', express.json({ limit: '2mb' }), (req, res) => {
    const body: unknown = req.body;
    if (!isResultBody(body)) {
      res.status(400).json({ error: 'A JSON body is required' });
      return;
    }

    const requestId = isString(body.requestId) ? body.requestId.trim() : '';
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }

    const matched = broker.resolve(requestId, {
      ok: body.ok === true,
      data: body.data ?? null,
      error: isString(body.error) ? body.error : '',
    });

    res.json({ matched });
  });
}
