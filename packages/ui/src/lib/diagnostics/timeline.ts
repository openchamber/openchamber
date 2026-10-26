export type DiagnosticEvent = {
  at: number;
  source: string;
  action: string;
  detail?: string;
};

const MAX_EVENTS = 1_500;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_IDENTITIES = 5_000;
const events: DiagnosticEvent[] = [];
let scopeStartedAt = Date.now();
let evicted = 0;
const identities = new Map<string, string>();
const identityCounts = { session: 0, directory: 0, message: 0 };
const CONSOLE_TAGS = new Set([
  'sync', 'startup-trace', 'mobile-connect', 'mobile-storage', 'relay',
  'opencode', 'session', 'runtime', 'desktop', 'websocket', 'notification',
]);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
const SAFE_ERROR_MESSAGES = new Set([
  'Script error.', 'Failed to fetch', 'Load failed',
  'NetworkError when attempting to fetch resource.', 'The operation was aborted.',
]);

const rendererErrorMessage = (error?: Error | null, fallback?: string): string | undefined => {
  try {
    const message = error instanceof Error ? error.message : fallback;
    if (!message || message.length > 256) return undefined;
    if (SAFE_ERROR_MESSAGES.has(message)) return message;
    const read = /^Cannot read properties of (null|undefined) \(reading ['"][^'"\r\n]{1,80}['"]\)$/.exec(message);
    if (read) return `Cannot read properties of ${read[1]} (reading [property])`;
    const write = /^Cannot set properties of (null|undefined) \(setting ['"][^'"\r\n]{1,80}['"]\)$/.exec(message);
    if (write) return `Cannot set properties of ${write[1]} (setting [property])`;
  } catch { /* Error objects may have custom message getters. */ }
  return undefined;
};

function rendererErrorName(error: Error | null): string | undefined {
  try {
    return error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : undefined;
  } catch {
    return undefined;
  }
}

export function rendererRejectionDetail(reason: Error | null): string {
  const name = rendererErrorName(reason);
  const message = rendererErrorMessage(reason);
  return [`type=${name ?? 'unavailable'}`, message && `message="${message}"`].filter(Boolean).join(' ');
}

/** Only local built asset names and numeric positions may leave the renderer. */
export function rendererErrorDetail(event: Pick<ErrorEvent, 'filename' | 'lineno' | 'colno' | 'error'> & Partial<Pick<ErrorEvent, 'message'>>, pageUrl: string): string | undefined {
  const fields = [];
  const name = rendererErrorName(event.error);
  fields.push(`type=${name ?? 'unavailable'}`);
  const message = rendererErrorMessage(event.error, event.message);
  if (message) fields.push(`message="${message}"`);
  let verifiedLocation = false;
  try {
    const page = new URL(pageUrl);
    const location = new URL(event.filename, page);
    if (location.protocol === page.protocol && location.host === page.host && /^\/assets\/[A-Za-z0-9_.-]{1,120}\.js$/.test(location.pathname)) {
      verifiedLocation = true;
      fields.push(`asset=${/^\/assets\/main-[A-Za-z0-9_-]{8,12}\.js$/.test(location.pathname) ? 'main' : 'chunk'}`);
      if (Number.isInteger(event.lineno) && event.lineno > 0 && event.lineno <= 10_000_000) fields.push(`line=${event.lineno}`);
      if (Number.isInteger(event.colno) && event.colno > 0 && event.colno <= 10_000_000) fields.push(`column=${event.colno}`);
    }
  } catch { /* Nonlocal and malformed locations cannot enter the export. */ }
  if (!verifiedLocation) fields.push(`location=${event.filename ? 'unverified' : 'unavailable'}`);
  return fields.join(' ');
}

/** Free-form console arguments can contain secrets. Inspect only a short prefix. */
export function recordRendererConsole(level: 'debug' | 'info' | 'log' | 'warn' | 'error', first: string, error?: Error | null): void {
  const tag = /^\[([a-z-]+)\]/i.exec(first.slice(0, 64))?.[1]?.toLowerCase();
  const knownTag = tag && CONSOLE_TAGS.has(tag) ? tag : null;
  if (!knownTag && level !== 'warn' && level !== 'error') return;
  const name = rendererErrorName(error ?? null);
  const message = rendererErrorMessage(error);
  recordDiagnosticEvent({
    at: Date.now(),
    source: knownTag ? `renderer/${knownTag}` : 'renderer',
    action: `console.${level}`,
    detail: [name && `type=${name}`, message && `message="${message}"`].filter(Boolean).join(' ') || undefined,
  });
}

/** Correlate local events without putting the original identifier in the log. */
export function diagnosticIdentity(kind: 'session' | 'directory' | 'message', value: string): string {
  if (!value || value.length > 1_024) return 'unavailable';
  const key = `${kind}\0${value}`;
  const known = identities.get(key);
  if (known) return known;
  const label = `${kind}-${++identityCounts[kind]}`;
  if (identities.size === MAX_IDENTITIES) {
    const oldest = identities.keys().next().value;
    if (oldest) identities.delete(oldest);
  }
  identities.set(key, label);
  return label;
}

/** Only call this with fields chosen for the export. Never pass raw API bodies or console arguments. */
export function recordDiagnosticEvent(event: DiagnosticEvent): void {
  if (!Number.isFinite(event.at)) return;
  events.push(event);
  const cutoff = Date.now() - MAX_AGE_MS;
  while (events.length > MAX_EVENTS || (events[0] && events[0].at < cutoff)) {
    events.shift();
    evicted++;
  }
}

export function getDiagnosticEvents(): DiagnosticEvent[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return events.filter((event) => event.at >= cutoff);
}

export function getDiagnosticOmittedCount(): number {
  const cutoff = Date.now() - MAX_AGE_MS;
  return evicted + events.filter((event) => event.at < cutoff).length;
}

export function clearDiagnosticEvents(): void {
  events.length = 0;
  scopeStartedAt = Date.now();
  evicted = 0;
  identities.clear();
  identityCounts.session = 0;
  identityCounts.directory = 0;
  identityCounts.message = 0;
}

export function getDiagnosticScopeStartedAt(): number {
  return scopeStartedAt;
}

export function mergeDiagnosticEvents(...sources: DiagnosticEvent[][]): DiagnosticEvent[] {
  return sources.flat().sort((left, right) => left.at - right.at);
}

export function formatDiagnosticEvents(eventsToFormat: DiagnosticEvent[]): string {
  return eventsToFormat.map(({ at, source, action, detail }) =>
    `${new Date(at).toISOString()} [${source}] ${action}${detail ? ` ${detail}` : ''}`,
  ).join('\n') + '\n';
}
