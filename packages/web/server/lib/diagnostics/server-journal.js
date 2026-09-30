const MAX_EVENTS = 4_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_LINE_LENGTH = 4_096;
const BURST_MS = 10_000;
const HTTP_BURST_MS = 10 * 60_000;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HTTP_ROUTES = new Set([
  '/api/info', '/api/provider', '/api/session', '/api/session/active',
  '/api/event', '/api/global/event', '/api/config', '/api/config/providers',
  '/api/project', '/api/agent', '/api/model',
]);
const HTTP_ROUTE_PATTERNS = [
  [/^\/api\/session\/[^/]+\/message\/[^/]+$/, '/api/session/:sessionID/message/:messageID'],
  [/^\/api\/session\/[^/]+\/message$/, '/api/session/:sessionID/message'],
  [/^\/api\/session\/[^/]+\/(?:prompt|command|interrupt|fork|form|permission)$/, null],
  [/^\/api\/session\/[^/]+$/, '/api/session/:sessionID'],
  [/^\/api\/provider\/[^/]+$/, '/api/provider/:providerID'],
];

const httpRoute = (pathname) => {
  if (HTTP_ROUTES.has(pathname)) return pathname;
  for (const [pattern, route] of HTTP_ROUTE_PATTERNS) {
    if (pattern.test(pathname)) {
      if (route) return route;
      const action = pathname.slice(pathname.lastIndexOf('/') + 1);
      return `/api/session/:sessionID/${action}`;
    }
  }
  return pathname?.startsWith('/api/') ? '/api/other' : '/other';
};
const ACTIONS = new Set([
  'managed launch', 'managed ready', 'managed startup failed', 'managed process exited',
  'managed restart started', 'managed restart ready', 'managed restart failed',
  'external connected', 'external unavailable', 'health failed', 'health recovered',
  'bootstrap failed', 'bootstrap ready',
]);
const FAILURE_CLASSES = new Set(['timeout', 'connection_refused', 'connection_reset', 'invalid_response', 'error']);
const LEVELS = { TRACE: 'info', DEBUG: 'info', INFO: 'info', WARN: 'warning', ERROR: 'error', FATAL: 'error' };
const MANAGED_MESSAGES = new Map([
  ['cli starting', 'cli starting'],
  ['database schema bootstrap started', 'database bootstrap started'],
  ['database schema bootstrap completed', 'database bootstrap completed'],
  ['location services booted', 'location services booted'],
  ['watcher subscribe', 'watcher activity'],
  ['watcher started', 'watcher started'],
  ['spawning process', 'subprocess spawned'],
]);

/** Process-local history. Only fixed actions and numeric/enum details may enter this buffer. */
export function createServerDiagnosticJournal({ now = Date.now, maxEvents = MAX_EVENTS, maxAgeMs = MAX_AGE_MS } = {}) {
  const events = new Array(maxEvents);
  let head = 0;
  let size = 0;
  let evictedServer = 0;
  let evictedManaged = 0;
  let oversizedLines = 0;
  let filteredLines = 0;
  let filteredWarnings = 0;
  let filteredErrors = 0;
  let mode = 'unavailable';

  const evict = () => {
    if (events[head].event.source === 'server journal') evictedServer++;
    else evictedManaged++;
    events[head] = undefined;
    head = (head + 1) % maxEvents;
    size--;
  };

  const prune = () => {
    const cutoff = now() - maxAgeMs;
    while (size && events[head].receivedAt < cutoff) {
      evict();
    }
  };

  const add = (source, action, at = now(), detail) => {
    prune();
    if (size === maxEvents) {
      evict();
    }
    const event = { at, source, action };
    if (detail) event.detail = detail;
    events[(head + size) % maxEvents] = { receivedAt: now(), event };
    size++;
  };

  return {
    record(action, { attempt, failureClass } = {}) {
      if (!ACTIONS.has(action)) return;
      const details = [];
      if (Number.isInteger(attempt) && attempt >= 1 && attempt <= 100) details.push(`attempt=${attempt}`);
      if (FAILURE_CLASSES.has(failureClass)) details.push(`class=${failureClass}`);
      add('server journal', action, now(), details.join(' ') || undefined);
    },
    recordHttpResponse(method, pathname, status) {
      if (!HTTP_METHODS.has(method) || !Number.isInteger(status) || status < 400 || status > 599) return;
      const detail = `method=${method} route=${httpRoute(pathname)} stage=downstream_response http=${status}`;
      const at = now();
      prune();
      const index = (head + size - 1) % maxEvents;
      const last = size ? events[index] : null;
      const elapsed = last ? at - last.receivedAt : 0;
      if (last?.event.action === 'http response completed' && last.baseDetail === detail
        && elapsed >= 0 && at - last.event.at <= HTTP_BURST_MS && last.repeats < 4_000) {
        last.repeats++;
        last.receivedAt = at;
        last.event.detail = `${detail} count=${last.repeats} spanMs=${at - last.event.at}`;
        return;
      }
      add('server journal', 'http response completed', at, detail);
      Object.assign(events[(head + size - 1) % maxEvents], { baseDetail: detail, repeats: 1 });
    },
    beginManagedProcess(attempt, stderrAvailable = true) {
      mode = stderrAvailable ? 'managed' : 'unavailable';
      this.record('managed launch', { attempt });
    },
    markExternal() {
      mode = 'external';
      this.record('external connected');
    },
    markExternalUnavailable() {
      mode = 'external';
      this.record('external unavailable');
    },
    recordManagedLine(line) {
      if (line.length > MAX_LINE_LENGTH) {
        oversizedLines++;
        return;
      }
      // OpenCode 2.x's structured stderr formatter. Never copy message, path,
      // run ID, or annotations, even when they appear to be harmless.
      const match = /^timestamp=(\S+) level=(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|Trace|Debug|Info|Warn|Error|Fatal) run=[a-f0-9]{8}(?:\s|$)/.exec(line);
      if (!match) {
        if (line.trim()) filteredLines++;
        return;
      }
      const message = /^message=(?:"([^"\\]{1,90})"|([a-z ]{1,90}))(?:\s|$)/.exec(line.slice(match[0].length));
      const level = LEVELS[match[2].toUpperCase()];
      const category = level === 'info' ? MANAGED_MESSAGES.get(message?.[1] ?? message?.[2]) : undefined;
      if (!category) {
        filteredLines++;
        if (level === 'warning') filteredWarnings++;
        if (level === 'error') filteredErrors++;
        return;
      }
      const time = Date.parse(match[1]);
      const at = Number.isFinite(time) && Math.abs(time - now()) < 5 * 60_000 ? time : now();
      prune();
      if (category === 'watcher activity' || category === 'watcher started') {
        const subscribed = category === 'watcher activity' ? 1 : 0;
        const started = 1 - subscribed;
        const index = (head + size - 1) % maxEvents;
        const last = size ? events[index] : null;
        const elapsed = last ? now() - last.receivedAt : 0;
        if (last?.event.action === 'info: watcher activity' && elapsed >= 0 && elapsed <= BURST_MS
          && last.subscribed + subscribed <= 100_000 && last.started + started <= 100_000) {
          events[index] = {
            ...last, subscribed: last.subscribed + subscribed, started: last.started + started,
            event: { ...last.event, detail: `subscribed=${last.subscribed + subscribed} started=${last.started + started} spanMs=${elapsed}` },
          };
        } else {
          add('managed OpenCode', 'info: watcher activity', at, `subscribed=${subscribed} started=${started} spanMs=0`);
          Object.assign(events[(head + size - 1) % maxEvents], { subscribed, started });
        }
        return;
      }
      if (category === 'subprocess spawned' && size) {
        const index = (head + size - 1) % maxEvents;
        const last = events[index];
        const elapsed = now() - last.receivedAt;
        if (last.event.source === 'managed OpenCode' && last.event.action === 'info: subprocess spawned'
          && elapsed >= 0 && elapsed <= BURST_MS && (last.repeats ?? 1) < 100_000) {
          events[index] = {
            ...last,
            repeats: (last.repeats ?? 1) + 1,
            event: { ...last.event, detail: `count=${(last.repeats ?? 1) + 1} spanMs=${elapsed}` },
          };
          return;
        }
      }
      add('managed OpenCode', `${level}: ${category}`, at);
    },
    omitManagedLine() { oversizedLines++; },
    snapshot() {
      prune();
      const retained = Array.from({ length: size }, (_, index) => events[(head + index) % maxEvents].event);
      const serverEvents = retained.some((event) => event.source === 'server journal');
      const managedEvents = retained.some((event) => event.source === 'managed OpenCode');
      const serverCoverage = { source: 'server journal', status: evictedServer ? 'truncated' : serverEvents ? 'read' : 'empty' };
      if (evictedServer) serverCoverage.omitted = evictedServer;
      const managedCoverage = {
        source: 'managed OpenCode',
        status: mode === 'external' ? 'skipped' : mode === 'unavailable' ? 'unavailable' : evictedManaged || oversizedLines ? 'truncated' : managedEvents ? 'read' : filteredLines ? 'filtered' : 'empty',
      };
      if (mode === 'managed' && evictedManaged + oversizedLines) managedCoverage.omitted = evictedManaged + oversizedLines;
      if (mode === 'managed' && filteredLines) managedCoverage.filtered = filteredLines;
      if (mode === 'managed' && filteredWarnings) managedCoverage.warnings = filteredWarnings;
      if (mode === 'managed' && filteredErrors) managedCoverage.errors = filteredErrors;
      return {
        events: retained,
        coverage: [serverCoverage, managedCoverage],
      };
    },
  };
}

/** One stderr reader per child, attached at spawn (not after readiness). */
export function createManagedLogCapture(journal) {
  let pending = '';
  let skipping = false;
  return {
    feed(chunk) {
      const text = chunk.toString();
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline;
        if (!skipping) {
          const segment = text.slice(start, end);
          if (pending.length + segment.length > MAX_LINE_LENGTH) {
            journal.omitManagedLine();
            pending = '';
            skipping = true;
          } else {
            pending += segment;
          }
        }
        if (newline < 0) break;
        if (!skipping) journal.recordManagedLine(pending.replace(/\r$/, ''));
        pending = '';
        skipping = false;
        start = newline + 1;
      }
    },
    flush() {
      if (!skipping && pending) journal.recordManagedLine(pending);
      pending = '';
      skipping = false;
    },
  };
}

export const serverDiagnosticJournal = createServerDiagnosticJournal();
