/**
 * Result callback for in-app browser actions.
 *
 * The client that owns the browser view posts here with the outcome of a
 * request it received over the event stream. Only the request id is trusted to
 * correlate; an unknown id is accepted with `matched: false` rather than an
 * error, because a client answering after a timeout has done nothing wrong.
 */
export function registerBrowserControlRoutes(app, { express, broker, getOpenChamberEventClients, inventoryRecorder }) {
  if (typeof getOpenChamberEventClients !== 'function' || !inventoryRecorder) {
    throw new TypeError('getOpenChamberEventClients and inventoryRecorder are required');
  }
  // Claiming is separate from answering so that a client learns whether it may
  // act *before* it acts. Deciding by whose result arrives first would be too
  // late: by then every client has already clicked.
  app.post('/api/browser-control/claim', express.json({ limit: '4kb' }), (req, res) => {
    const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId.trim() : '';
    if (!requestId) {
      res.status(400).json({ error: 'requestId is required' });
      return;
    }
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
    res.json(broker.claim(requestId, clientId));
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

    const claimToken = typeof body.claimToken === 'string' && body.claimToken ? body.claimToken : '';
    if (!claimToken) {
      res.status(400).json({ error: 'claimToken is required' });
      return;
    }

    const matched = broker.resolve(requestId, {
      ok: body.ok === true,
      data: body.data ?? null,
      error: typeof body.error === 'string' ? body.error : '',
    }, claimToken);

    res.json({ matched });
  });

  // Each window periodically reports what it can serve: the directory it can
  // open tabs in, the controllers it has registered, and the tab it is
  // showing. Delivery matches requests against this, so a stale or forged
  // report would misroute agent actions — the caps below keep one window's
  // report bounded, and the per-client monotonic revision keeps out-of-order
  // posts from overwriting newer state. Tab ids embed full URLs, so they are
  // bounded only by the body limit, not by a field cap.
  app.post('/api/browser-control/inventory', express.json({ limit: '256kb' }), (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'A JSON body is required' });
      return;
    }

    const isBoundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

    const clientId = body.clientId;
    if (!isBoundedString(clientId, 64)) {
      res.status(400).json({ error: 'clientId must be a string of at most 64 characters' });
      return;
    }
    const revision = body.revision;
    if (typeof revision !== 'number' || !Number.isFinite(revision)) {
      res.status(400).json({ error: 'revision must be a finite number' });
      return;
    }
    const openableDirectory = body.openableDirectory ?? null;
    if (openableDirectory !== null && !isBoundedString(openableDirectory, 1024)) {
      res.status(400).json({ error: 'openableDirectory must be null or a string of at most 1024 characters' });
      return;
    }
    const controllers = body.controllers;
    if (!Array.isArray(controllers) || controllers.length > 64) {
      res.status(400).json({ error: 'controllers must be an array of at most 64 entries' });
      return;
    }
    for (const entry of controllers) {
      if (!entry || typeof entry !== 'object' || !isBoundedString(entry.directory, 1024) || typeof entry.tabId !== 'string') {
        res.status(400).json({ error: 'each controller needs a directory (<=1024 chars) and a tabId string' });
        return;
      }
    }
    const activeTarget = body.activeTarget ?? null;
    if (activeTarget !== null && (
      typeof activeTarget !== 'object'
      || !isBoundedString(activeTarget.directory, 1024)
      || typeof activeTarget.tabId !== 'string'
    )) {
      res.status(400).json({ error: 'activeTarget must be null or { directory (<=1024 chars), tabId string }' });
      return;
    }

    const recorded = inventoryRecorder.record(getOpenChamberEventClients(), clientId, {
      revision,
      openableDirectory,
      controllers: controllers.map((entry) => ({ directory: entry.directory, tabId: entry.tabId })),
      activeTarget: activeTarget ? { directory: activeTarget.directory, tabId: activeTarget.tabId } : null,
      hasFocus: body.hasFocus === true,
    });
    res.json({ recorded });
  });
}
