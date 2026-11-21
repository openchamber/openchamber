import { z } from 'zod';

import type { createBrowserControlBroker } from './broker.js';
import type { BrowserControlApp, BrowserControlHandler } from './http-contracts.js';
import type { PreferredBrowserClient } from './preferred-client.js';

const activeBodySchema = z.object({
  connectionId: z.string().trim().min(1),
  previousConnectionId: z.string().trim().min(1).nullable().default(null),
});

interface ResultBody {
  requestId?: unknown;
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

const isResultBody = (value: unknown): value is ResultBody => Boolean(value) && typeof value === 'object';
const isString = (value: unknown): value is string => typeof value === 'string';

export function registerBrowserControlRoutes(app: Pick<BrowserControlApp, 'post'>, { express, broker, preferredClient }: {
  express: { json: (options: { limit: string }) => BrowserControlHandler };
  broker: Pick<ReturnType<typeof createBrowserControlBroker>, 'claim' | 'resolve'>;
  preferredClient: Pick<PreferredBrowserClient, 'markActive'>;
}) {
  app.post('/api/browser-control/active', express.json({ limit: '4kb' }), (req, res) => {
    const body = activeBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'connectionId is required' });
      return;
    }
    const preferredConnectionId = preferredClient.markActive(body.data.connectionId, body.data.previousConnectionId);
    if (!preferredConnectionId) {
      res.status(409).json({ error: 'No open connection with that id can drive a page' });
      return;
    }
    res.json({ preferredConnectionId });
  });

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
