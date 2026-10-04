// Short-lived shared answers for provider reads (issue and pull request lists,
// previews, comments), so the picker, the comparison view, the PR panel and
// every connected client asking the same thing within seconds cost one
// provider call.
//
// A GET is answered from here when the same path and query succeeded within
// its TTL; identical requests in flight wait for the first one. The query
// carries the bound read context (account, repository, binding revision), so a
// key is exactly one answer. Only successful, connected answers are kept: a
// failure or "not connected" is never replayed. Anything that changes a
// provider (a POST to its routes: mutations, sign-in, account switch) clears
// that provider's answers, and so does an agent turn finishing, since the
// agent may have opened or changed something.

const SECOND = 1000;
const MAX_ENTRIES = 300;
// A larger answer (a merge request context with its diff) is served but not kept.
const MAX_CACHED_BYTES = 2 * 1024 * 1024;

const ROUTES = [
  { prefix: '/api/source-control/github', provider: 'github' },
  { prefix: '/api/source-control/gitlab', provider: 'gitlab' },
  { prefix: '/api/linear', provider: 'linear' },
];

// Lists change when something is opened or closed; previews and comments are
// read again sooner when someone is looking at one.
const CACHED_READS = new Map([
  ['/references', 30 * SECOND],
  ['/references/detail', 15 * SECOND],
  ['/issues/list', 30 * SECOND],
  ['/issues/get', 15 * SECOND],
  ['/issues/comments', 15 * SECOND],
  ['/pulls/list', 30 * SECOND],
  ['/pulls/context', 15 * SECOND],
]);

const routeOf = (path) => ROUTES.find((route) => path.startsWith(`${route.prefix}/`)) ?? null;

const requestKey = (req, provider) => {
  const url = new URL(req.originalUrl, 'http://localhost');
  const query = [...url.searchParams.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${provider}|${url.pathname}?${new URLSearchParams(query).toString()}`;
};

const isConnectedAnswer = (body) => !(Object.prototype.toString.call(body) === '[object Object]' && body.connected === false);

export function createProviderReadCache({ now = Date.now } = {}) {
  const entries = new Map();
  const inFlight = new Map();

  const clear = (provider) => {
    for (const key of entries.keys()) if (!provider || key.startsWith(`${provider}|`)) entries.delete(key);
    // Requests already running may carry the old state; they still answer
    // their own callers, but their result is not kept.
    for (const [key, flight] of inFlight) if (!provider || key.startsWith(`${provider}|`)) flight.stale = true;
  };

  const remember = (key, body, ttlMs) => {
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_CACHED_BYTES) return;
    entries.delete(key);
    entries.set(key, { body, expiresAt: now() + ttlMs });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  };

  /** Express middleware; register it before the provider routes. */
  const middleware = (req, res, next) => {
    const route = routeOf(req.path);
    if (!route) return next();
    if (req.method !== 'GET') {
      // A change to this provider makes every kept answer of it suspect.
      res.on('finish', () => { if (res.statusCode < 400) clear(route.provider); });
      return next();
    }
    const ttlMs = CACHED_READS.get(req.path.slice(route.prefix.length));
    if (!ttlMs) return next();
    const key = requestKey(req, route.provider);
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now()) return res.json(cached.body);
    if (cached) entries.delete(key);

    const pending = inFlight.get(key);
    if (pending) {
      pending.promise.then((answer) => {
        if (answer) return res.status(answer.status).json(answer.body);
        // The first request did not produce a shareable answer; ask on our own.
        return next();
      });
      return undefined;
    }

    let settle;
    const flight = { stale: false, promise: new Promise((resolve) => { settle = resolve; }) };
    inFlight.set(key, flight);
    const done = (answer) => {
      if (inFlight.get(key) === flight) inFlight.delete(key);
      settle(answer);
    };
    const json = res.json.bind(res);
    res.json = (body) => {
      const shareable = res.statusCode === 200 && isConnectedAnswer(body);
      if (shareable && !flight.stale) remember(key, body, ttlMs);
      done(shareable ? { status: 200, body } : null);
      return json(body);
    };
    // A handler that answered some other way (stream, error page) shares nothing.
    res.on('close', () => done(null));
    return next();
  };

  return { middleware, clear };
}
