export function registerBrowserControlRoutes(app, { express, broker }) {
  app.post('/api/browser-control/claim', express.json({ limit: '4kb' }), (req, res) => {
    const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    res.json({ granted: broker.claim(requestId) });
  });

  app.post('/api/browser-control/result', express.json({ limit: '2mb' }), (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'A JSON body is required' });
      return;
    }

    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }

    const matched = broker.resolve(requestId, {
      ok: body.ok === true,
      data: body.data ?? null,
      error: typeof body.error === 'string' ? body.error : '',
    });

    res.json({ matched });
  });
}
