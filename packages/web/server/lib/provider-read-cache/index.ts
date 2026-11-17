import { sourceControlProviderDescriptors } from '../source-control/provider-descriptors.js';

export type ProviderReadBody = string | number | boolean | null | undefined | ProviderReadBody[] | { [key: string]: ProviderReadBody };

export interface RefreshedSourceControlItem {
  owner: string;
  repo: string;
  number: number;
}

export interface RefreshedTrackerItem {
  identifier: string;
}

type TrackerIds = string[] | (() => string[]);

export interface ProviderReadCacheOptions {
  sourceControlProviderIds?: string[];
  trackerIds?: TrackerIds;
  now?: () => number;
  onChange?: (provider: string) => void;
  onItemRefresh?: (provider: string, item: RefreshedSourceControlItem | RefreshedTrackerItem) => void;
}

interface ProviderReadRequest {
  path: string;
  originalUrl: string;
  method: string;
}

interface ProviderReadResponse {
  statusCode: number;
  status: (code: number) => ProviderReadResponse;
  json: (body?: ProviderReadBody) => ProviderReadResponse;
  on: (event: 'finish' | 'close', listener: () => void) => ProviderReadResponse;
}

interface ProviderRoute {
  prefix: string;
  provider: string;
  tracker: boolean;
}

interface CachedAnswer {
  body: ProviderReadBody;
  expiresAt: number;
}

interface SharedAnswer {
  status: number;
  body: ProviderReadBody;
}

interface InFlightRead {
  stale: boolean;
  promise: Promise<SharedAnswer | null>;
}

type CacheMatcher = (subpath: string, params: URLSearchParams, body: ProviderReadBody) => boolean;

const hasResponseFields = (value: ProviderReadBody): value is { [key: string]: ProviderReadBody } => (
  value !== null && typeof value === 'object'
);

const isTrackerIdReader = (value: TrackerIds): value is () => string[] => typeof value === 'function';

const SECOND = 1000;
const MAX_ENTRIES = 300;
const MAX_CACHED_BYTES = 2 * 1024 * 1024;

const LEGACY_TRACKER_PREFIXES = Object.freeze({ linear: '/api/linear' });

const TRACKER_PATH = /^\/api\/tracker\/([a-z][a-z0-9-]{0,31})\//;

const routeOfPath = (path: string, sourceControlRoutes: ProviderRoute[], hasTracker: (provider: string) => boolean) => {
  const sourceControl = sourceControlRoutes.find((route) => path.startsWith(`${route.prefix}/`));
  if (sourceControl) return sourceControl;
  const tracker = TRACKER_PATH.exec(path);
  if (tracker && tracker[1] !== undefined && hasTracker(tracker[1])) return { prefix: `/api/tracker/${tracker[1]}`, provider: tracker[1], tracker: true };
  for (const [provider, prefix] of Object.entries(LEGACY_TRACKER_PREFIXES)) {
    if (path.startsWith(`${prefix}/`) && hasTracker(provider)) return { prefix, provider, tracker: true };
  }
  return null;
};

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

const POST_READS = new Set(['/references/across']);

const LIST_READS = new Set(['/references', '/references/status', '/issues/list', '/pulls/list', '/items/list']);

const TRACKER_ITEM_READS = new Set(['/items/get', '/issues/get']);

const lower = (value: string | null | undefined) => String(value ?? '').toLowerCase();

const refreshedWorkItem = (searchParams: URLSearchParams) => {
  const identifier = String(searchParams.get('identifier') ?? '').trim().toUpperCase();
  return identifier ? { identifier } : null;
};

const trackerAnswerIsAbout = (subpath: string, params: URLSearchParams, item: RefreshedTrackerItem, body: ProviderReadBody) => {
  if (TRACKER_ITEM_READS.has(subpath)) {
    const read = hasResponseFields(body) ? body.item ?? body.issue : undefined;
    return body === undefined || String((hasResponseFields(read) ? read.identifier : undefined) ?? '').toUpperCase() === item.identifier;
  }
  return LIST_READS.has(subpath) && lower(params.get('query')).trim() === lower(item.identifier);
};

const refreshedItem = (searchParams: URLSearchParams) => {
  const number = Number(searchParams.get('number'));
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: searchParams.get('owner') ?? '', repo: searchParams.get('repo') ?? '', number };
};

const answerIsAbout = (subpath: string, params: URLSearchParams, item: RefreshedSourceControlItem) => {
  const sameProject = (owner: string | null | undefined, repo: string | null | undefined) => !owner || !item.owner || (lower(owner) === lower(item.owner) && lower(repo) === lower(item.repo));
  if (subpath === '/references/status') {
    const wanted = `${lower(item.owner)}/${lower(item.repo)}#${item.number}`;
    return lower(params.get('pulls')).split(',').includes(wanted);
  }
  if (subpath === '/references') {
    const query = lower(params.get('query')).trim();
    if (!query) return false;
    if (query === `#${item.number}` || query === String(item.number)) return true;
    const link = query.match(/\/([^/]+)\/([^/]+)\/(?:-\/)?(?:pull|pulls|issues|merge_requests|discussions)\/(\d+)/);
    return link !== null && Number(link[3]) === item.number && sameProject(link[1], link[2]);
  }
  return Number(params.get('number')) === item.number && sameProject(params.get('owner'), params.get('repo'));
};

const requestKey = (req: ProviderReadRequest, route: ProviderRoute) => {
  const url = new URL(req.originalUrl, 'http://localhost');
  const query = [...url.searchParams.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${route.provider}|${route.prefix}|${url.pathname}?${new URLSearchParams(query).toString()}`;
};

const parseKey = (key: string) => {
  const [provider, prefix] = key.split('|', 2);
  if (provider === undefined || prefix === undefined) throw new Error('Provider cache key is missing its route');
  const url = new URL(key.slice(provider.length + prefix.length + 2), 'http://localhost');
  return { provider, subpath: url.pathname.slice(prefix.length), params: url.searchParams };
};

const isConnectedAnswer = (body: ProviderReadBody) => !(Object.prototype.toString.call(body) === '[object Object]' && hasResponseFields(body) && body.connected === false);

export function createProviderReadCache({
  sourceControlProviderIds = sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id),
  trackerIds = [],
  now = Date.now,
  onChange = () => {},
  onItemRefresh = () => {},
}: ProviderReadCacheOptions = {}) {
  const sourceControlRoutes = sourceControlProviderIds.map((provider) => ({ prefix: `/api/source-control/${provider}`, provider, tracker: false }));
  const hasTracker = (provider: string) => (isTrackerIdReader(trackerIds) ? trackerIds() : trackerIds).includes(provider);
  const routeOf = (path: string) => routeOfPath(path, sourceControlRoutes, hasTracker);
  const entries = new Map<string, CachedAnswer>();
  const inFlight = new Map<string, InFlightRead>();

  const clear = (provider?: string, matches: CacheMatcher | null = null) => {
    const picked = (key: string, body: ProviderReadBody) => {
      const parsed = parseKey(key);
      if (provider && parsed.provider !== provider) return false;
      return !matches || matches(parsed.subpath, parsed.params, body);
    };
    for (const [key, entry] of entries) if (picked(key, entry.body)) entries.delete(key);
    for (const [key, flight] of inFlight) if (picked(key, undefined)) flight.stale = true;
  };

  const remember = (key: string, body: ProviderReadBody, ttlMs: number) => {
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_CACHED_BYTES) return;
    entries.delete(key);
    entries.set(key, { body, expiresAt: now() + ttlMs });
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) throw new Error('Provider cache has no oldest entry');
      entries.delete(oldest.value);
    }
  };

  const middleware = (req: ProviderReadRequest, res: ProviderReadResponse, next: () => void) => {
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
        return next();
      });
      return undefined;
    }

    let settle: (answer: SharedAnswer | null) => void;
    const flight = { stale: false, promise: new Promise<SharedAnswer | null>((resolve) => { settle = resolve; }) };
    inFlight.set(key, flight);
    const done = (answer: SharedAnswer | null) => {
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
    res.on('close', () => done(null));
    return next();
  };

  return { middleware, clear };
}
