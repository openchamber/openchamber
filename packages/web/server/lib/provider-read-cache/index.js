import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

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
// agent may have opened or changed something. Both are reported through
// `onChange(provider)`, so the live state the server follows is read again too.
//
// `POST <prefix>/read-cache/refresh` forgets answers on request, for a change
// made on the provider's own site, as narrowly as the refresh asks:
// `?scope=item&owner=&repo=&number=` (`?scope=item&identifier=` for a
// tracker; the preview's refresh button) forgets what was read about that one
// item and reports it through `onItemRefresh(provider, item)`;
// `?scope=lists` (the board's list refresh) forgets the lists and the
// statuses read for them. Without a scope every answer of the provider goes,
// as for a change.
//
// The prefixes are built from the registries: `/api/source-control/<id>` per
// source-control provider and `/api/tracker/<id>` per tracker, plus the
// legacy `/api/linear` alias, which is the same provider as
// `/api/tracker/linear`, so a change through either forgets both.

const SECOND = 1000;
const MAX_ENTRIES = 300;
// A larger answer (a merge request context with its diff) is served but not kept.
const MAX_CACHED_BYTES = 2 * 1024 * 1024;

// The legacy Linear routes stay beside `/api/tracker/linear` for older clients.
const LEGACY_TRACKER_PREFIXES = Object.freeze({ linear: '/api/linear' });

const routesOf = (sourceControlProviderIds, trackerIds) => [
  ...sourceControlProviderIds.map((provider) => ({ prefix: `/api/source-control/${provider}`, provider, tracker: false })),
  ...trackerIds.flatMap((provider) => [
    { prefix: `/api/tracker/${provider}`, provider, tracker: true },
    ...(LEGACY_TRACKER_PREFIXES[provider] ? [{ prefix: LEGACY_TRACKER_PREFIXES[provider], provider, tracker: true }] : []),
  ]),
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
  ['/items/list', 30 * SECOND],
  ['/items/get', 15 * SECOND],
]);

// Reads sent as a POST because their request is too large for a query; they
// change nothing, so they neither clear answers nor count as a change.
const POST_READS = new Set(['/references/across']);

// Reads that list items, rather than read one: a list refresh forgets these.
const LIST_READS = new Set(['/references', '/references/status', '/issues/list', '/pulls/list', '/items/list']);

// A tracker's reads of one item (the tracker routes and the legacy Linear ones).
const TRACKER_ITEM_READS = new Set(['/items/get', '/issues/get']);

const lower = (value) => String(value ?? '').toLowerCase();

/** The one tracker item a scoped refresh names, by its identifier. */
const refreshedWorkItem = (searchParams) => {
  const identifier = String(searchParams.get('identifier') ?? '').trim().toUpperCase();
  return identifier ? { identifier } : null;
};

/**
 * Whether a kept tracker answer was read about the work item: its own read,
 * which names it by the provider's id, so the answer's body says which one it
 * was (a read still in flight has no body yet and is forgotten), and a
 * search for its identifier.
 */
const trackerAnswerIsAbout = (subpath, params, item, body) => {
  if (TRACKER_ITEM_READS.has(subpath)) {
    const read = body?.item ?? body?.issue;
    return body === undefined || String(read?.identifier ?? '').toUpperCase() === item.identifier;
  }
  return LIST_READS.has(subpath) && lower(params.get('query')).trim() === lower(item.identifier);
};

/** The one item a scoped refresh names, or null when the query names none. */
const refreshedItem = (searchParams) => {
  const number = Number(searchParams.get('number'));
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: searchParams.get('owner') ?? '', repo: searchParams.get('repo') ?? '', number };
};

/**
 * Whether a kept answer was read about `item`: its own reads (detail,
 * comments, context, get) by number and project, a status read that asked
 * for it, and a search that looked it up by its link or number (the Tracker
 * reads a tab's item that way). A read without a project matches by number;
 * forgetting one answer too many only costs a read.
 */
const answerIsAbout = (subpath, params, item) => {
  const sameProject = (owner, repo) => !owner || !item.owner || (lower(owner) === lower(item.owner) && lower(repo) === lower(item.repo));
  if (subpath === '/references/status') {
    const wanted = `${lower(item.owner)}/${lower(item.repo)}#${item.number}`;
    return lower(params.get('pulls')).split(',').includes(wanted);
  }
  if (subpath === '/references') {
    const query = lower(params.get('query')).trim();
    if (!query) return false;
    if (query === `#${item.number}` || query === String(item.number)) return true;
    const link = query.match(/\/([^/]+)\/([^/]+)\/(?:-\/)?(?:pull|pulls|issues|merge_requests)\/(\d+)/);
    return Boolean(link) && Number(link[3]) === item.number && sameProject(link[1], link[2]);
  }
  return Number(params.get('number')) === item.number && sameProject(params.get('owner'), params.get('repo'));
};

// A key names the provider and the prefix it was read under, so a forget that
// matches by subpath slices each kept answer with its own prefix (the legacy
// alias is shorter than the tracker route).
const requestKey = (req, route) => {
  const url = new URL(req.originalUrl, 'http://localhost');
  const query = [...url.searchParams.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${route.provider}|${route.prefix}|${url.pathname}?${new URLSearchParams(query).toString()}`;
};

const parseKey = (key) => {
  const [provider, prefix] = key.split('|', 2);
  const url = new URL(key.slice(provider.length + prefix.length + 2), 'http://localhost');
  return { provider, subpath: url.pathname.slice(prefix.length), params: url.searchParams };
};

const isConnectedAnswer = (body) => !(Object.prototype.toString.call(body) === '[object Object]' && body.connected === false);

/**
 * `sourceControlProviderIds` and `trackerIds` are the registered ids, in the
 * one namespace both registries share.
 */
export function createProviderReadCache({
  sourceControlProviderIds = sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id),
  trackerIds = [],
  now = Date.now,
  onChange = () => {},
  onItemRefresh = () => {},
} = {}) {
  const routes = routesOf(sourceControlProviderIds, trackerIds);
  const routeOf = (path) => routes.find((route) => path.startsWith(`${route.prefix}/`)) ?? null;
  const entries = new Map();
  const inFlight = new Map();

  /** Forgets the provider's answers `matches(subpath, params, body)` picks; all of them without it. */
  const clear = (provider, matches = null) => {
    const picked = (key, body) => {
      const parsed = parseKey(key);
      if (provider && parsed.provider !== provider) return false;
      return !matches || matches(parsed.subpath, parsed.params, body);
    };
    for (const [key, entry] of entries) if (picked(key, entry.body)) entries.delete(key);
    // Requests already running may carry the old state; they still answer
    // their own callers, but their result is not kept.
    for (const [key, flight] of inFlight) if (picked(key, undefined)) flight.stale = true;
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
    const subpath = req.path.slice(route.prefix.length);
    if (req.method === 'POST' && subpath === '/read-cache/refresh') {
      const { searchParams } = new URL(req.originalUrl, 'http://localhost');
      const scope = searchParams.get('scope');
      if (scope === 'item' && route.tracker) {
        const item = refreshedWorkItem(searchParams);
        if (!item) return res.status(400).json({ error: 'identifier is required to refresh one item' });
        clear(route.provider, (path, params, body) => trackerAnswerIsAbout(path, params, item, body));
        onItemRefresh(route.provider, item);
        return res.json({ ok: true });
      }
      if (scope === 'item') {
        const item = refreshedItem(searchParams);
        if (!item) return res.status(400).json({ error: 'number is required to refresh one item' });
        clear(route.provider, (path, params) => answerIsAbout(path, params, item));
        onItemRefresh(route.provider, item);
        return res.json({ ok: true });
      }
      if (scope === 'lists') {
        clear(route.provider, (path) => LIST_READS.has(path));
        return res.json({ ok: true });
      }
      clear(route.provider);
      onChange(route.provider);
      return res.json({ ok: true });
    }
    if (req.method === 'POST' && POST_READS.has(subpath)) return next();
    if (req.method !== 'GET') {
      // A change to this provider makes every kept answer of it suspect.
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        clear(route.provider);
        onChange(route.provider);
      });
      return next();
    }
    const ttlMs = CACHED_READS.get(subpath);
    if (!ttlMs) return next();
    const key = requestKey(req, route);
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
