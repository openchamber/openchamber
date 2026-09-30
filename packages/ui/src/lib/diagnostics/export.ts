import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getRecentSendFailures } from '@/sync/send-failure-log';
import { getRecentSessionErrors } from '@/sync/session-error-log';
import { z } from 'zod';
import { diagnosticIdentity, formatDiagnosticEvents, getDiagnosticEvents, getDiagnosticOmittedCount, getDiagnosticScopeStartedAt, mergeDiagnosticEvents, recordDiagnosticEvent, type DiagnosticEvent } from './timeline';
import { isLocalDiagnosticRuntime, sampleServerHealth } from './capture';

type FileDiagnostics = { events: DiagnosticEvent[]; coverage: { source: string; status: string; omitted?: number; filtered?: number; warnings?: number; errors?: number }[] };
const SESSION_ERROR_TYPES = new Set(['ProviderAuthError', 'UnknownError', 'MessageAbortedError', 'ContextOverflowError', 'APIError']);
const fileSources = new Set([
  'desktop', 'web', 'OpenCode', 'startup', 'update', 'startup-performance', 'electron',
  'lifecycle', 'relay-identity', 'Relay', 'ScheduledTasks', 'scheduled-tasks', 'ipc', 'webview',
  'config', 'mobile-connect', 'proxy', 'server journal', 'managed OpenCode',
  'message-stream WS', 'PushWatcher',
]);
const fileActions = new Set([
  'connection attempt', 'connection started', 'connection already in progress',
  'tunnel handoff', 'remote server discovery failed', 'remote server stop failed',
  'remote server authentication mismatch', 'remote server left running',
  'remote server version replaced', 'remote server bind replaced',
  'managed server launch', 'managed server startup failed',
  'health check failed', 'managed server restarting', 'orphan cleanup failed',
  'app starting', 'startup failed', 'server shutdown failed', 'update install failed',
  'updater error', 'LAN access blocked', 'IPC rejected', 'api proxy failed',
  'http request failed', 'upstream event stream failed',
  'relay signing key generated', 'relay encryption key generated',
]);
const managedActions = new Set([
  'cli starting', 'database bootstrap started', 'database bootstrap completed',
  'location services booted', 'watcher activity',
  'subprocess spawned',
]);
const journalActions = new Set([
  'managed launch', 'managed ready', 'managed startup failed', 'managed process exited',
  'managed restart started', 'managed restart ready', 'managed restart failed',
  'external connected', 'external unavailable', 'health failed', 'health recovered',
  'bootstrap failed', 'bootstrap ready', 'http response completed',
]);
const proxyRoutes = new Set([
  '/api/info', '/api/provider', '/api/session', '/api/session/active',
  '/api/event', '/api/global/event', '/api/config', '/api/config/providers',
  '/api/project', '/api/agent', '/api/model',
  '/api/session/:sessionID', '/api/session/:sessionID/message',
  '/api/session/:sessionID/message/:messageID', '/api/session/:sessionID/prompt',
  '/api/session/:sessionID/command', '/api/session/:sessionID/interrupt',
  '/api/session/:sessionID/fork', '/api/session/:sessionID/form',
  '/api/session/:sessionID/permission', '/api/provider/:providerID',
  '/api/other',
]);
const proxyMessages = new Set([
  'fetch failed', 'socket hang up', 'connect ECONNREFUSED [address]',
  'connect ETIMEDOUT [address]', 'getaddrinfo ENOTFOUND [host]', 'unavailable',
]);
const proxyDetailPattern = /^method=(?:GET|POST|PUT|PATCH|DELETE|OTHER) route=(\/api\/[A-Za-z:/]+) function=(?:forwardSseRequest|forwardSanitizedSessionListRequest|forwardSessionGetRequest|onApiProxyError) class=(?:connection_refused|connection_reset|timeout|dns_failed|error)(?: message="([^"\r\n]{1,70})"(?: cause="([^"\r\n]{1,70})")?)?$/;
const isSafeProxyDetail = (detail: string): boolean => {
  const match = proxyDetailPattern.exec(detail);
  return Boolean(match && proxyRoutes.has(match[1])
    && (!match[2] || proxyMessages.has(match[2]))
    && (!match[3] || proxyMessages.has(match[3])));
};
const isSafeHttpRequestDetail = (detail: string): boolean => {
  const match = /^method=(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) route=(\/api\/[A-Za-z:/]+|\/other) http=[45]\d\d(?: count=([1-9]\d{0,3}) spanMs=(0|[1-9]\d{0,5}))?$/.exec(detail);
  return Boolean(match && (match[1] === '/other' || proxyRoutes.has(match[1]))
    && (!match[2] || (Number(match[2]) >= 2 && Number(match[2]) <= 4_000 && Number(match[3]) <= 600_000)));
};
const isSafeCompletedHttpDetail = (detail: string): boolean => {
  const match = /^method=(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) route=(\/api\/[A-Za-z:/]+|\/other) stage=downstream_response http=[45]\d\d(?: count=([1-9]\d{0,3}) spanMs=(0|[1-9]\d{0,5}))?$/.exec(detail);
  return Boolean(match && (match[1] === '/other' || proxyRoutes.has(match[1]))
    && (!match[2] || (Number(match[2]) >= 2 && Number(match[2]) <= 4_000 && Number(match[3]) <= 600_000)));
};
const isSafeStreamFailureDetail = (detail: string): boolean => {
  const match = /^route=\/api\/event function=createUpstreamSseReader stage=(upstream_connect_or_read|upstream_stream_attempt) message="(fetch failed|terminated|OpenCode service unavailable)"(?: count=([1-9]\d{0,3}) spanMs=(0|[1-9]\d{0,5}))?$/.exec(detail);
  return Boolean(match && (match[1] === 'upstream_connect_or_read' || match[2] === 'OpenCode service unavailable')
    && (match[2] !== 'OpenCode service unavailable' || match[1] === 'upstream_stream_attempt')
    && (!match[3] || (Number(match[3]) >= 2 && Number(match[3]) <= 4_000 && Number(match[4]) <= 600_000)));
};
const streamSources = new Set(['message-stream WS', 'PushWatcher']);
const sshPhases = new Set([
  'idle', 'config_resolved', 'auth_check', 'master_connecting', 'remote_probe',
  'updating', 'installing', 'server_detecting', 'server_starting', 'forwarding',
  'ready', 'degraded', 'error',
]);
const eventSchema = z.object({
  at: z.number().int().min(0).max(8_640_000_000_000_000),
  source: z.string().refine((source) => fileSources.has(source) || /^SSH connection (?:[1-9]|1\d|20)$/.test(source)),
  action: z.string().refine((action) => {
    const phase = /^(?:current phase |(?:info|warning|error): phase )([a-z_]+)$/.exec(action);
    if (phase) return sshPhases.has(phase[1]);
    const named = /^(?:info|warning|error): ([a-z ]+)$/.exec(action);
    return Boolean(named && (fileActions.has(named[1]) || managedActions.has(named[1]))) || journalActions.has(action);
  }),
  detail: z.string().refine((detail) =>
    /^attempt=\d{1,3}\/\d{1,3} class=(?:timeout|connection_refused|connection_reset|invalid_response|error)$/.test(detail)
    || /^retry=\d{1,3} userAction=(?:true|false)$/.test(detail)
    || /^(?:attempt=(?:[1-9]|[1-9]\d|100))(?: class=(?:timeout|connection_refused|connection_reset|invalid_response|error))?$/.test(detail)
    || /^class=(?:timeout|connection_refused|connection_reset|invalid_response|error)$/.test(detail)
    || detail === 'class=connection_refused message="connect ECONNREFUSED [address]"'
    || detail === 'message="Cannot find latest-mac.yml in the latest release artifacts" http=404'
    || isSafeProxyDetail(detail)
    || isSafeHttpRequestDetail(detail)
    || isSafeCompletedHttpDetail(detail)
    || isSafeStreamFailureDetail(detail)
    || /^count=(?:[2-9]|[1-9]\d{1,4}|100000) spanMs=(?:\d{1,4}|10000)$/.test(detail)
    || /^subscribed=(?:0|[1-9]\d{0,4}|100000) started=(?:0|[1-9]\d{0,4}|100000) spanMs=(?:\d{1,4}|10000)$/.test(detail)).optional(),
}).refine((event) => event.source !== 'managed OpenCode'
  || /^(?:info|warning|error): ([a-z ]+)$/.test(event.action)
    && managedActions.has(event.action.replace(/^(?:info|warning|error): /, ''))
    && (event.action === 'info: watcher activity'
      ? /^subscribed=\d+ started=\d+ spanMs=\d+$/.test(event.detail ?? '')
      : !event.detail || event.action === 'info: subprocess spawned' && /^count=\d+ spanMs=\d+$/.test(event.detail)))
  .refine((event) => event.source !== 'proxy' || event.action === 'error: api proxy failed')
  .refine((event) => event.detail !== 'message="Cannot find latest-mac.yml in the latest release artifacts" http=404'
    || (event.source === 'electron' && event.action === 'error: updater error'))
  .refine((event) => event.action !== 'error: http request failed'
    || (['desktop', 'web'].includes(event.source) && Boolean(event.detail && isSafeHttpRequestDetail(event.detail))))
  .refine((event) => event.action !== 'http response completed'
    || (event.source === 'server journal' && Boolean(event.detail && isSafeCompletedHttpDetail(event.detail))))
  .refine((event) => streamSources.has(event.source) === (event.action === 'warning: upstream event stream failed')
    && (event.action !== 'warning: upstream event stream failed' || Boolean(event.detail && isSafeStreamFailureDetail(event.detail))));
const coverageSchema = z.object({
  source: z.string().refine((source) => fileSources.has(source) || ['local SSH manager', 'local files', 'file events'].includes(source)),
  status: z.enum(['read', 'empty', 'filtered', 'missing', 'older files omitted', 'nonregular', 'truncated', 'unreadable', 'unavailable', 'skipped']),
  omitted: z.number().int().nonnegative().optional(),
  filtered: z.number().int().nonnegative().optional(),
  warnings: z.number().int().nonnegative().optional(),
  errors: z.number().int().nonnegative().optional(),
});
const fileResponseSchema = z.object({
  events: z.array(z.unknown()).max(16_000),
  coverage: z.array(z.unknown()).max(100),
});

/** The envelope is parsed at the transport boundary; validate every record separately. */
export function parseFileDiagnostics(response: z.infer<typeof fileResponseSchema>): FileDiagnostics {
  const events = response.events.flatMap((item) => {
    const result = eventSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
  const coverage: FileDiagnostics['coverage'] = response.coverage.flatMap((item) => {
    const result = coverageSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
  const omitted = response.events.length - events.length + response.coverage.length - coverage.length;
  if (omitted) coverage.push({ source: 'diagnostic transport', status: 'invalid records omitted', omitted });
  return { events, coverage };
}

const collectFiles = async (): Promise<FileDiagnostics | null> => {
  if (!isLocalDiagnosticRuntime()) return null;
  if (canUseElectronDesktopIPC()) {
    const response = fileResponseSchema.safeParse(await invokeDesktop('desktop_collect_local_diagnostics'));
    return response.success ? parseFileDiagnostics(response.data) : null;
  }
  const url = getRuntimeUrlResolver().api('/api/diagnostics/local-files');
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await runtimeFetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = fileResponseSchema.safeParse(await response.json());
    return payload.success ? parseFileDiagnostics(payload.data) : null;
  } finally {
    clearTimeout(timeout);
  }
};

const probeOpenCode = async (): Promise<DiagnosticEvent[]> => {
  if (!isLocalDiagnosticRuntime()) return [];
  const endpoints = ['/api/info', '/api/provider', '/api/session/active'];
  return Promise.all(endpoints.map(async (route) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await runtimeFetch(getRuntimeUrlResolver().api(route), { signal: controller.signal });
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      const content = contentType.includes('html') ? 'html' : contentType.includes('json') ? 'json' : contentType ? 'other' : 'none';
      return { at: Date.now(), source: 'OpenCode API', action: `${route.slice(5)} probe`, detail: `method=GET route=${route} function=probeOpenCode http=${response.status} content=${content} timeMs=${Date.now() - startedAt}` };
    } catch {
      return { at: Date.now(), source: 'OpenCode API', action: `${route.slice(5)} probe failed`, detail: `method=GET route=${route} function=probeOpenCode reason=${controller.signal.aborted ? 'timeout' : 'transport'} timeMs=${Date.now() - startedAt}` };
    } finally {
      clearTimeout(timeout);
    }
  }));
};

export async function buildDiagnosticLog(): Promise<string> {
  const unavailable = () => `OpenChamber diagnostic timeline\nGenerated: ${new Date().toISOString()}\n\nSources:\n- Local diagnostics: skipped (active runtime is not the local instance)\n\nEvents (0):\n`;
  if (!isLocalDiagnosticRuntime()) return unavailable();
  const scope = getRuntimeKey();
  recordDiagnosticEvent({ at: Date.now(), source: 'ui', action: 'diagnostic export requested' });
  const [health, probes] = await Promise.all([sampleServerHealth(), probeOpenCode()]);
  const at = Date.now();
  let files: FileDiagnostics | null = null;
  try { files = await collectFiles(); } catch { /* Include all other sources and mark files unavailable. */ }
  if (getRuntimeKey() !== scope || !isLocalDiagnosticRuntime()) return unavailable();
  const scopeStartedAt = getDiagnosticScopeStartedAt();
  const buffered: DiagnosticEvent[] = [
    ...getRecentSessionErrors().filter((entry) => entry.at >= scopeStartedAt).map((entry) => ({
      at: entry.at, source: 'session.error', action: 'turn failed',
      detail: `session=${diagnosticIdentity('session', entry.sessionId)} directory=${entry.directory ? diagnosticIdentity('directory', entry.directory) : 'unavailable'}`
        + (entry.name && SESSION_ERROR_TYPES.has(entry.name) ? ` type=${entry.name}` : ''),
    })),
    ...getRecentSendFailures().filter((entry) => entry.at >= scopeStartedAt).map((entry) => ({
      at: entry.at, source: 'send', action: 'rejected',
      detail: `session=${diagnosticIdentity('session', entry.sessionId)} message=${diagnosticIdentity('message', entry.messageId)}`
        + ` directory=${entry.directory ? diagnosticIdentity('directory', entry.directory) : 'unavailable'}`
        + ` status=${entry.status ?? 'transport'} ambiguous=${entry.ambiguous} confirmationChecked=${entry.confirmationChecked}`,
    })),
  ];
  const coverage = files?.coverage.map(({ source, status, omitted, filtered, warnings, errors }) =>
    `${source}: ${status}${omitted ? ` (${omitted} lines omitted)` : ''}${filtered ? ` (${filtered} lines without a safe classification excluded; ${warnings ?? 0} warnings, ${errors ?? 0} errors)` : ''}`,
  ) ?? ['Local file/SSH diagnostics: unavailable (route or IPC failed)'];
  if (!canUseElectronDesktopIPC()) coverage.push('Local SSH manager: unavailable outside desktop');
  coverage.push('Remote SSH host logs and containers: not read');
  coverage.push('OpenCode shared file directory: not read; managed logs are captured from the owned child process only');
  coverage.push('Renderer console and errors: captured after app mount; raw arguments are discarded, known error messages use fixed templates');
  coverage.push('Session, directory and message labels: local to this runtime and reset on a runtime switch; names, IDs and paths are not exported');
  coverage.push('Dedicated mobile debug buffer and VS Code output: separate app processes, not in this export');
  coverage.push('File lines: known diagnostic categories and vetted error-message templates only; unknown lines and private identifiers omitted');
  coverage.push(`UI/renderer buffer: 1,500 events or 24 hours; ${getDiagnosticOmittedCount()} older events omitted`);
  coverage.push('Server journal: bounded history of managed lifecycle transitions and stderr categories; external OpenCode logs are not read');
  const events = mergeDiagnosticEvents(files?.events ?? [], getDiagnosticEvents(), buffered, probes);
  const current = health
    ? `HTTP ${health.http}, OpenCode running=${health.running}, ready=${health.ready}, secure=${health.secure}, port=${health.port ?? 'unknown'}, WSL=${health.wsl}`
    : 'unavailable (health request failed or response invalid)';
  return `OpenChamber diagnostic timeline\nGenerated: ${new Date(at).toISOString()}\n\nCurrent health: ${current}\n\nSources:\n${coverage.map((item) => `- ${item}`).join('\n')}\n\nEvents (${events.length}):\n${formatDiagnosticEvents(events)}`;
}
