import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverDiagnosticJournal } from './server-journal.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES_PER_FILE = 4_000;
const MAX_FILES_PER_SOURCE = 6;
const MAX_EVENTS = 8_000;
const MAX_SSH_EVENTS = 8_000;
const REQUEST_BURST_MS = 10 * 60 * 1_000;
const TIMESTAMP = /(20\d\d-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d{1,3})?(?:Z|[+-]\d\d:?\d\d)?)/;
const COMPONENTS = ['startup-performance', 'electron', 'OpenCode', 'lifecycle', 'relay-identity', 'Relay', 'ScheduledTasks', 'scheduled-tasks', 'ipc', 'webview', 'config', 'mobile-connect', 'proxy'];
const KNOWN_EVENTS = [
  { pattern: /^\[OpenCode\] Launching managed server\b/, action: 'managed server launch' },
  { pattern: /^\[OpenCode\] Managed server startup failed\b/, action: 'managed server startup failed' },
  { pattern: /^\[lifecycle\] .*?health check failed\b/, action: 'health check failed' },
  { pattern: /^\[lifecycle\] .*?restarting OpenCode\b/, action: 'managed server restarting' },
  { pattern: /^\[lifecycle\] orphan reap failed\b/, action: 'orphan cleanup failed' },
  { pattern: /^\[electron\] app starting\b/, action: 'app starting' },
  { pattern: /^\[electron\] startup failed\b/, action: 'startup failed' },
  { pattern: /^\[electron\] embedded server shutdown failed\b/, action: 'server shutdown failed' },
  { pattern: /^\[electron\] update install failed\b/, action: 'update install failed' },
  { pattern: /^\[electron\] autoUpdater error\b/, action: 'updater error' },
  { pattern: /^\[desktop\] LAN access was requested without a desktop UI password\b/, action: 'LAN access blocked' },
  { pattern: /^\[ipc\] rejected\b/, action: 'IPC rejected' },
  { pattern: /^\[proxy\] OpenCode proxy error:/, action: 'api proxy failed' },
  { pattern: /^\[proxy\] OpenCode (?:SSE|session\.get|session\.list) proxy error:/, action: 'api proxy failed' },
  { pattern: /^\[relay-identity\] Generating NEW relay signing keypair\b/, action: 'relay signing key generated' },
  { pattern: /^\[relay-identity\] Generating NEW relay encryption keypair\b/, action: 'relay encryption key generated' },
];
const PROXY_ROUTES = new Set([
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
const PROXY_MESSAGES = new Set([
  'fetch failed', 'socket hang up', 'connect ECONNREFUSED [address]',
  'connect ETIMEDOUT [address]', 'getaddrinfo ENOTFOUND [host]', 'unavailable',
]);
// Both listeners report the same shared /api/event SSE reader failure. Match
// entire known messages; the surrounding log line may contain private data.
const STREAM_FAILURES = new Map([
  ['Message stream WS proxy error: TypeError: fetch failed', ['message-stream WS', 'fetch failed', 'upstream_connect_or_read']],
  ['[PushWatcher] disconnected fetch failed', ['PushWatcher', 'fetch failed', 'upstream_connect_or_read']],
  ['Message stream WS proxy error: TypeError: terminated', ['message-stream WS', 'terminated', 'upstream_connect_or_read']],
  ['[PushWatcher] disconnected terminated', ['PushWatcher', 'terminated', 'upstream_connect_or_read']],
  ['Message stream WS proxy error: Error: OpenCode service unavailable', ['message-stream WS', 'OpenCode service unavailable', 'upstream_stream_attempt']],
  ['[PushWatcher] disconnected OpenCode service unavailable', ['PushWatcher', 'OpenCode service unavailable', 'upstream_stream_attempt']],
]);
const SSH_PHASES = new Set([
  'idle', 'config_resolved', 'auth_check', 'master_connecting', 'remote_probe',
  'updating', 'installing', 'server_detecting', 'server_starting', 'forwarding',
  'ready', 'degraded', 'error',
]);
const SSH_MESSAGES = [
  { pattern: /^Starting SSH connection$/, action: 'connection started' },
  { pattern: /^Connection already in progress$/, action: 'connection already in progress' },
  { pattern: /^Main tunnel helper exited after ControlMaster handoff$/, action: 'tunnel handoff' },
  { pattern: /^Could not list OpenChamber servers on the remote host\b/, action: 'remote server discovery failed' },
  { pattern: /^The managed server on remote port \d{1,5} did not stop\b/, action: 'remote server stop failed' },
  { pattern: /^Not reusing the server on remote port \d{1,5}: it does not take this instance's UI password\b/, action: 'remote server authentication mismatch' },
  { pattern: /^Not reusing the server on remote port \d{1,5}: it runs in the foreground\b/, action: 'remote server left running' },
  { pattern: /^Replacing the managed server on remote port \d{1,5}: it runs OpenChamber\b/, action: 'remote server version replaced' },
  { pattern: /^Replacing the managed server on remote port \d{1,5}: it is bound to\b/, action: 'remote server bind replaced' },
];

// Never export arbitrary log text: it may be a prompt, path, token, URL or provider response.
// Fixed vocabulary is the only information admitted from free-form log lines.
export const classifyLogLine = (line, source) => {
  const matched = TIMESTAMP.exec(line);
  if (!matched) return null;
  // Without a timezone a log timestamp is local wall time, not UTC.
  const at = Date.parse(matched[1].replace(',', '.').replace(' ', 'T'));
  if (!Number.isFinite(at)) return null;
  // electron-log encloses the timestamp in brackets; web logs do not.
  const afterTimestamp = line.slice(matched.index + matched[0].length).replace(/^\]\s*/, '').trimStart();
  const level = /^\[(info|warn|error|debug)\]\s*/i.exec(afterTimestamp);
  const body = level ? afterTimestamp.slice(level[0].length) : afterTimestamp;
  const severity = level?.[1].toLowerCase() === 'error' ? 'error' : level?.[1].toLowerCase() === 'warn' ? 'warning' : 'info';
  const streamFailure = severity === 'warning' ? STREAM_FAILURES.get(body) : undefined;
  const component = streamFailure?.[0] || COMPONENTS.find((name) => body.startsWith(`[${name}]`)) || source;
  const action = streamFailure ? 'upstream event stream failed' : KNOWN_EVENTS.find(({ pattern }) => pattern.test(body))?.action;
  const health = /^\[lifecycle\] .*?health check failed \((\d{1,3})\/(\d{1,3})\) class=(timeout|connection_refused|connection_reset|invalid_response|error)\b/.exec(body);
  const event = { at, source: component, action: `${severity}: ${action}` };
  if (health) event.detail = `attempt=${health[1]}/${health[2]} class=${health[3]}`;
  if (streamFailure) {
    event.detail = `route=/api/event function=createUpstreamSseReader stage=${streamFailure[2]} message="${streamFailure[1]}"`;
    return event;
  }
  // The desktop log also contains failed HTTP access records. Never copy the
  // path, query, request ID or timing from a free-form line into the export.
  const request = source === 'desktop' || source === 'web'
    ? /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S{1,2048}) - ([45]\d\d) with id [A-Za-z0-9:]{8,64} in \d{1,6}ms$/.exec(body)
    : null;
  if (request && severity === 'error') {
    const pathname = request[2].split(/[?#]/, 1)[0];
    const route = PROXY_ROUTES.has(pathname) && !pathname.includes(':')
      ? pathname : pathname.startsWith('/api/') ? '/api/other' : '/other';
    return { at, source, action: 'error: http request failed', detail: `method=${request[1]} route=${route} http=${request[3]}` };
  }
  if (!action) return null;
  if (action === 'updater error'
    && /^\[electron\] autoUpdater error Error: Cannot find latest-mac\.yml in the latest release artifacts \(https:\/\/[^\s()]{1,512}\): HttpError: 404\s*$/.test(body)) {
    event.detail = 'message="Cannot find latest-mac.yml in the latest release artifacts" http=404';
  }
  if (action === 'api proxy failed') {
    const oldProxy = /^\[proxy\] OpenCode (SSE|session\.get|session\.list) proxy error: fetch failed$/.exec(body);
    if (oldProxy) {
      const route = oldProxy[1] === 'SSE' ? '/api/event' : oldProxy[1] === 'session.get' ? '/api/session/:sessionID' : '/api/session';
      const handler = oldProxy[1] === 'SSE' ? 'forwardSseRequest' : oldProxy[1] === 'session.get' ? 'forwardSessionGetRequest' : 'forwardSanitizedSessionListRequest';
      event.detail = `method=GET route=${route} function=${handler} class=error message="fetch failed"`;
      return event;
    }
    const proxy = /^\[proxy\] OpenCode proxy error: method=(GET|POST|PUT|PATCH|DELETE|OTHER) route=(\/api\/[A-Za-z:/]+) function=(forwardSseRequest|forwardSanitizedSessionListRequest|forwardSessionGetRequest|onApiProxyError) class=(connection_refused|connection_reset|timeout|dns_failed|error)(?: message="([^"\r\n]{1,70})"(?: cause="([^"\r\n]{1,70})")?)?$/.exec(body);
    if (proxy && PROXY_ROUTES.has(proxy[2]) && (!proxy[5] || PROXY_MESSAGES.has(proxy[5])) && (!proxy[6] || PROXY_MESSAGES.has(proxy[6]))) {
      event.detail = `method=${proxy[1]} route=${proxy[2]} function=${proxy[3]} class=${proxy[4]}`;
      if (proxy[5]) event.detail += ` message="${proxy[5]}"`;
      if (proxy[6]) event.detail += ` cause="${proxy[6]}"`;
    }
    if (!event.detail) return null;
  }
  return event;
};

// SSH manager messages include remote stderr and sometimes host names. Read them
// only inside the native process; return a fixed vocabulary to the renderer.
export const classifySshLogLine = (line, source) => {
  const match = /^\[(\d{13})\] \[(INFO|WARN|ERROR)\] (.*)$/.exec(line);
  if (!match) return null;
  const at = Number(match[1]);
  if (!Number.isSafeInteger(at)) return null;
  const body = match[3];
  const phase = /^phase="([a-z_]+)"(?:\s|$)/.exec(body);
  const action = phase && SSH_PHASES.has(phase[1])
    ? `phase ${phase[1]}`
    : /^-+ attempt #\d+ \((?:manual|retry \d+)\) -+$/.test(body)
      ? 'connection attempt'
      : SSH_MESSAGES.find(({ pattern }) => pattern.test(body))?.action;
  const severity = match[2] === 'INFO' ? 'info' : match[2] === 'WARN' ? 'warning' : 'error';
  if (!action) return null;
  return { at, source, action: `${severity}: ${action}` };
};

export const collectSshBufferDiagnostics = ({ entries, omittedSources }) => {
  const events = [];
  let omitted = 0;
  let warnings = 0;
  let errors = 0;
  for (const [index, snapshot] of entries.entries()) {
    const source = `SSH connection ${index + 1}`;
    for (const line of snapshot.lines) {
      const event = classifySshLogLine(line, source);
      if (event) events.push(event);
      else {
        omitted++;
        if (/^\[\d{13}\] \[WARN\]/.test(line)) warnings++;
        if (/^\[\d{13}\] \[ERROR\]/.test(line)) errors++;
      }
    }
    if (SSH_PHASES.has(snapshot.phase) && Number.isSafeInteger(snapshot.updatedAtMs)) {
      events.push({
        at: snapshot.updatedAtMs,
        source,
        action: `current phase ${snapshot.phase}`,
        detail: `retry=${Number.isInteger(snapshot.retryAttempt) ? Math.max(0, Math.min(100, snapshot.retryAttempt)) : 0} userAction=${snapshot.requiresUserAction === true}`,
      });
    }
  }
  const dropped = Math.max(0, events.length - MAX_SSH_EVENTS);
  const sourceCoverage = {
    source: 'local SSH manager',
    status: omittedSources || dropped ? 'truncated' : events.length ? 'read' : omitted ? 'filtered' : 'empty',
    omitted: omittedSources + dropped,
    filtered: omitted,
  };
  if (warnings) sourceCoverage.warnings = warnings;
  if (errors) sourceCoverage.errors = errors;
  return {
    events: events.sort((a, b) => a.at - b.at).slice(-MAX_SSH_EVENTS),
    coverage: [sourceCoverage],
  };
};

const readKnownFile = async (file, source) => {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) return { events: [], omitted: 0, filtered: 0, truncated: false, skipped: true };
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, stat.size - length);
    const lines = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (stat.size > length) lines.shift();
    const skippedLines = Math.max(0, lines.length - MAX_LINES_PER_FILE);
    if (skippedLines) lines.splice(0, skippedLines);
    const events = [];
    const failureBursts = new Map();
    let filtered = 0;
    let warnings = 0;
    let errors = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = classifyLogLine(line, source);
      if (!event) {
        filtered++;
        const level = /^(?:\[[^\]\r\n]{1,40}\]|\S{1,40})\s+\[(warn|error)\]/i.exec(line)?.[1]?.toLowerCase();
        if (level === 'warn') warnings++;
        if (level === 'error') errors++;
        continue;
      }
      if (event.action === 'error: http request failed' || event.action === 'warning: upstream event stream failed') {
        const key = `${event.source} ${event.action} ${event.detail}`;
        const burst = failureBursts.get(key);
        if (burst && event.at >= burst.at && event.at - burst.at <= REQUEST_BURST_MS) {
          burst.count++;
          burst.event.detail = `${event.detail} count=${burst.count} spanMs=${event.at - burst.at}`;
          continue;
        }
        failureBursts.set(key, { at: event.at, count: 1, event });
      }
      events.push(event);
    }
    return { events, omitted: skippedLines, filtered, warnings, errors, truncated: stat.size > length || skippedLines > 0, skipped: false };
  } finally {
    await handle.close();
  }
};

/** Read only fixed application log locations. Never accept a path from the renderer. */
export async function collectLocalFileDiagnostics({ electronLogPath, home = os.homedir(), env = process.env, webPort, journal = serverDiagnosticJournal } = {}) {
  const dataDir = env.OPENCHAMBER_DATA_DIR || path.join(home, '.config', 'openchamber');
  const sources = [
    ...(electronLogPath ? [{ name: 'desktop', folder: path.dirname(electronLogPath), matches: (name) => /^main(?:\.\d+)?\.log$/.test(name) }] : []),
    ...(Number.isInteger(webPort) && webPort > 0 ? [{ name: 'web', folder: path.join(dataDir, 'logs'), matches: (name) => name === `openchamber-${webPort}.log` }] : []),
    ...(process.platform === 'darwin' ? [{ name: 'startup', folder: path.join(home, 'Library', 'Logs', 'OpenChamber'), matches: (name) => /^startup(?:\.err)?\.log$/.test(name) }] : []),
    { name: 'update', folder: dataDir, matches: (name) => name === 'update-install.log' },
  ];
  const { events: journalEvents, coverage: journalCoverage } = journal.snapshot();
  const events = [...journalEvents];
  const coverage = [...journalCoverage];
  for (const source of sources) {
    try {
      const matching = (await fs.readdir(source.folder)).filter(source.matches).sort();
      const entries = matching.slice(-MAX_FILES_PER_SOURCE);
      if (matching.length > entries.length) {
        coverage.push({ source: source.name, status: 'older files omitted', omitted: matching.length - entries.length });
      }
      if (entries.length === 0) {
        coverage.push({ source: source.name, status: 'missing' });
        continue;
      }
      for (const name of entries) {
        try {
          const result = await readKnownFile(path.join(source.folder, name), source.name);
          events.push(...result.events);
          const sourceCoverage = {
            source: source.name,
            status: result.skipped ? 'nonregular' : result.truncated ? 'truncated' : result.events.length ? 'read' : result.filtered ? 'filtered' : 'empty',
            omitted: result.omitted,
            filtered: result.filtered,
          };
          if (result.warnings) sourceCoverage.warnings = result.warnings;
          if (result.errors) sourceCoverage.errors = result.errors;
          coverage.push(sourceCoverage);
        } catch {
          coverage.push({ source: source.name, status: 'unreadable' });
        }
      }
    } catch {
      coverage.push({ source: source.name, status: 'unavailable' });
    }
  }
  if (events.length > MAX_EVENTS) coverage.push({ source: 'file events', status: 'truncated', omitted: events.length - MAX_EVENTS });
  return { events: events.sort((a, b) => a.at - b.at).slice(-MAX_EVENTS), coverage };
}
