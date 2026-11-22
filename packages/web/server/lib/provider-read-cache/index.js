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
// agent may have opened or changed something. `POST <prefix>/read-cache/refresh`
// clears them on request: the board's refresh button, for a change made on the
// provider's own site.

const SECOND = 1000;
const MAX_ENTRIES = 300;
// A larger answer (a merge request context with its diff) is served but not kept.
const MAX_CACHED_BYTES = 2 * 1024 * 1024;
// The per-entry cap above bounds one answer; this bounds the whole cache
// (#1770, the Octokit ETag cache's shape after #848): with only the entry
// count capped, 300 kept answers at the per-entry cap retain ~600 MiB of
// response bodies in the long-lived server. Eviction runs while either
// bound is exceeded. Only body bytes are counted.
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

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
  ['/references/status', 30 * SECOND],
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

export function createProviderReadCache({
  now = Date.now,
  maxEntries = MAX_ENTRIES,
  maxCachedBytes = MAX_CACHED_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
} = {}) {
  const entries = new Map();
  const inFlight = new Map();
  // Retained body bytes across all kept entries; every delete path
  // (evict, replace, expire, clear) settles it, so it always equals the
  // true retained total.
  let retainedBytes = 0;

  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    retainedBytes -= entry.size;
  };

  const clear = (provider) => {
    for (const key of [...entries.keys()]) if (!provider || key.startsWith(`${provider}|`)) drop(key);
    // Requests already running may carry the old state; they still answer
    // their own callers, but their result is not kept.
    for (const [key, flight] of inFlight) if (!provider || key.startsWith(`${provider}|`)) flight.stale = true;
  };

  const remember = (key, body, ttlMs) => {
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > maxCachedBytes) return;
    // Re-remembering a key replaces it: settle its old bytes first so a
    // key never counts twice.
    drop(key);
    entries.set(key, { body, expiresAt: now() + ttlMs, size });
    retainedBytes += size;
    while (entries.size > maxEntries || retainedBytes > maxTotalBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
  };

  /** Express middleware; register it before the provider routes. */
  const middleware = (req, res, next) => {
    const route = routeOf(req.path);
    if (!route) return next();
    if (req.method === 'POST' && req.path === `${route.prefix}/read-cache/refresh`) {
      clear(route.provider);
      return res.json({ ok: true });
    }
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
    if (cached) drop(key);

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
