/**
 * Result callback for in-app browser actions.
 *
 * The client that owns the browser view posts here with the outcome of a
 * request it received over the event stream. Only the request id is trusted to
 * correlate; an unknown id is accepted with `matched: false` rather than an
 * error, because a client answering after a timeout has done nothing wrong.
 */
export function registerBrowserControlRoutes(app, { express, broker }) {
  // Claiming is separate from answering so that a client learns whether it may
  // act *before* it acts. Deciding by whose result arrives first would be too
  // late: by then every client has already clicked.
  app.post('/api/browser-control/claim', express.json({ limit: '4kb' }), (req, res) => {
    const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    res.json({ granted: broker.claim(requestId) });
  });

  // This server attaches body parsing per route rather than globally. Without
  // it `req.body` is undefined here, the client's result is rejected, and the
  // agent sees an unexplained timeout instead of its answer. A page snapshot
  // carries the visible text plus every interactive element, so the limit is
  // sized for that rather than for a small control message.
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
