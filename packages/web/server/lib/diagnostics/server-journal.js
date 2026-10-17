import { diagnosticApiRoute } from './vocabulary.js';

const MAX_EVENTS = 4_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const HTTP_BURST_MS = 10 * 60_000;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ACTIONS = new Set([
  'managed launch', 'managed ready', 'managed startup failed', 'managed process exited',
  'managed restart started', 'managed restart ready', 'managed restart failed',
  'external connected', 'external unavailable', 'health failed', 'health recovered',
  'bootstrap failed', 'bootstrap ready',
]);
const FAILURE_CLASSES = new Set(['timeout', 'connection_refused', 'connection_reset', 'invalid_response', 'error']);

/** Process-local history. Only fixed actions and numeric/enum details may enter this buffer. */
export function createServerDiagnosticJournal({ now = Date.now, maxEvents = MAX_EVENTS, maxAgeMs = MAX_AGE_MS } = {}) {
  const events = new Array(maxEvents);
  let head = 0;
  let size = 0;
  let evicted = 0;

  const evict = () => {
    evicted++;
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

  const add = (action, at, detail) => {
    prune();
    if (size === maxEvents) {
      evict();
    }
    const event = { at, source: 'server journal', action };
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
      add(action, now(), details.join(' ') || undefined);
    },
    recordHttpResponse(method, pathname, status) {
      if (!HTTP_METHODS.has(method) || !Number.isInteger(status) || status < 400 || status > 599) return;
      const detail = `method=${method} route=${diagnosticApiRoute(pathname)} stage=downstream_response http=${status}`;
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
      add('http response completed', at, detail);
      Object.assign(events[(head + size - 1) % maxEvents], { baseDetail: detail, repeats: 1 });
    },
    snapshot() {
      prune();
      const retained = Array.from({ length: size }, (_, index) => events[(head + index) % maxEvents].event);
      const coverage = { source: 'server journal', status: evicted ? 'truncated' : retained.length ? 'read' : 'empty' };
      if (evicted) coverage.omitted = evicted;
      return { events: retained, coverage: [coverage] };
    },
  };
}

export const serverDiagnosticJournal = createServerDiagnosticJournal();
