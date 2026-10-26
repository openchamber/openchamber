// The fixed vocabulary the diagnostic timeline may carry. Writers (proxy logs,
// the server journal) map raw values onto it, and readers (log classification)
// admit only values from it. `packages/ui/src/lib/diagnostics/export.ts`
// re-validates the same vocabulary at the transport boundary; keep both in step.

const FIXED_ROUTES = [
  '/api/info', '/api/provider', '/api/session', '/api/session/active',
  '/api/event', '/api/global/event', '/api/config', '/api/config/providers',
  '/api/project', '/api/agent', '/api/model',
];

// Path parameters are session, message and provider IDs; only the template
// may leave the process.
const ROUTE_PATTERNS = [
  [/^\/api\/session\/[^/]+\/message\/[^/]+$/, '/api/session/:sessionID/message/:messageID'],
  [/^\/api\/session\/[^/]+\/message$/, '/api/session/:sessionID/message'],
  [/^\/api\/session\/[^/]+\/prompt$/, '/api/session/:sessionID/prompt'],
  [/^\/api\/session\/[^/]+\/command$/, '/api/session/:sessionID/command'],
  [/^\/api\/session\/[^/]+\/interrupt$/, '/api/session/:sessionID/interrupt'],
  [/^\/api\/session\/[^/]+\/fork$/, '/api/session/:sessionID/fork'],
  [/^\/api\/session\/[^/]+\/form$/, '/api/session/:sessionID/form'],
  [/^\/api\/session\/[^/]+\/permission$/, '/api/session/:sessionID/permission'],
  [/^\/api\/session\/[^/]+$/, '/api/session/:sessionID'],
  [/^\/api\/provider\/[^/]+$/, '/api/provider/:providerID'],
];

const FIXED_ROUTE_SET = new Set(FIXED_ROUTES);

/** Every route value a diagnostic event may contain. */
export const DIAGNOSTIC_API_ROUTES = new Set([
  ...FIXED_ROUTES,
  ...ROUTE_PATTERNS.map(([, route]) => route),
  '/api/other',
]);

/** Maps a request path to a route template; unknown paths collapse to a placeholder. */
export const diagnosticApiRoute = (pathname) => {
  if (FIXED_ROUTE_SET.has(pathname)) return pathname;
  const template = ROUTE_PATTERNS.find(([pattern]) => pattern.test(pathname))?.[1];
  if (template) return template;
  return pathname.startsWith('/api/') ? '/api/other' : '/other';
};

/** Transport error messages with their addresses replaced; nothing else is kept. */
export const DIAGNOSTIC_ERROR_MESSAGES = new Set([
  'fetch failed', 'socket hang up', 'connect ECONNREFUSED [address]',
  'connect ETIMEDOUT [address]', 'getaddrinfo ENOTFOUND [host]', 'unavailable',
]);

export const diagnosticErrorMessage = (message) => {
  if (message === 'fetch failed' || message === 'socket hang up') return message;
  if (!message || message.length > 256) return null;
  const connect = /^connect (ECONNREFUSED|ETIMEDOUT) (?:\d{1,3}(?:\.\d{1,3}){3}|\[[a-fA-F0-9:]+\]):\d{1,5}$/.exec(message);
  if (connect) return `connect ${connect[1]} [address]`;
  if (/^getaddrinfo ENOTFOUND \S{1,255}$/.test(message)) return 'getaddrinfo ENOTFOUND [host]';
  return null;
};
