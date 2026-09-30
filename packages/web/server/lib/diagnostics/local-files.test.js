import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyLogLine, classifySshLogLine, collectSshBufferDiagnostics, collectLocalFileDiagnostics } from './local-files.js';
import { createServerDiagnosticJournal } from './server-journal.js';

describe('local file diagnostics', () => {
  it('drops arbitrary log text and only exports fixed categories', () => {
    const entry = classifyLogLine('2026-09-28T10:00:00Z [error] [OpenCode] failed token=secret-123 /private/file', 'web');
    expect(entry).toBeNull();
    expect(JSON.stringify(entry)).not.toContain('secret-123');
    expect(classifyLogLine('no timestamp token=secret-123', 'web')).toBeNull();
    expect(classifyLogLine('2026-09-28T10:00:00Z [info] session token=secret-123', 'desktop')).toBeNull();
    expect(classifyLogLine('2026-09-28T10:00:00Z [info] [electron] app starting {"token":"secret-123"}', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00Z'), source: 'electron', action: 'info: app starting',
    });
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [warn] [relay-identity] Generating NEW relay signing keypair (serverId changes; secret-123)', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'relay-identity', action: 'warning: relay signing key generated',
    });
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [warn] [relay-identity] Generating NEW relay encryption keypair (secret-456)', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'relay-identity', action: 'warning: relay encryption key generated',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [warn] token="[relay-identity] Generating NEW relay signing keypair"', 'desktop')).toBeNull();
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [error] [proxy] OpenCode proxy error: connect ECONNREFUSED 127.0.0.1:5001 token=secret-123', 'desktop')).toBeNull();
    expect(classifyLogLine('2026-09-28T10:00:00Z [error] [proxy] OpenCode proxy error: private=secret-123 connect ECONNREFUSED', 'web')).toBeNull();
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [error] [proxy] OpenCode proxy error: method=POST route=/api/session/:sessionID/message function=onApiProxyError class=connection_refused', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'proxy', action: 'error: api proxy failed',
      detail: 'method=POST route=/api/session/:sessionID/message function=onApiProxyError class=connection_refused',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [error] [proxy] OpenCode proxy error: method=GET route=/api/session function=forwardSanitizedSessionListRequest class=connection_refused message="fetch failed" cause="connect ECONNREFUSED [address]"', 'web')).toEqual({
      at: Date.parse('2026-09-28T10:00:00Z'), source: 'proxy', action: 'error: api proxy failed',
      detail: 'method=GET route=/api/session function=forwardSanitizedSessionListRequest class=connection_refused message="fetch failed" cause="connect ECONNREFUSED [address]"',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [error] [proxy] OpenCode proxy error: method=GET route=/api/info function=onApiProxyError class=error message="token=secret-123"', 'web')).toBeNull();
    expect(classifyLogLine('2026-09-28T10:00:00Z [error] [proxy] OpenCode proxy error: method=GET route=/api/session/secret-123 function=onApiProxyError class=connection_refused', 'web')).toBeNull();
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [error] [proxy] OpenCode session.get proxy error: fetch failed', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'proxy', action: 'error: api proxy failed',
      detail: 'method=GET route=/api/session/:sessionID function=forwardSessionGetRequest class=error message="fetch failed"',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [error] [proxy] OpenCode SSE proxy error: Bearer secret-123', 'web')).toBeNull();
    const streamDetail = 'route=/api/event function=createUpstreamSseReader stage=upstream_connect_or_read message="fetch failed"';
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [warn] Message stream WS proxy error: TypeError: fetch failed', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'message-stream WS', action: 'warning: upstream event stream failed', detail: streamDetail,
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [warn] [PushWatcher] disconnected fetch failed', 'web')).toEqual({
      at: Date.parse('2026-09-28T10:00:00Z'), source: 'PushWatcher', action: 'warning: upstream event stream failed', detail: streamDetail,
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [warn] [PushWatcher] disconnected fetch failed token=secret-123', 'web')).toBeNull();
    expect(classifyLogLine('2026-09-28T10:00:00Z [warn] Message stream WS proxy error: TypeError: fetch failed /private/file', 'desktop')).toBeNull();
    for (const [message, stage] of [['terminated', 'upstream_connect_or_read'], ['OpenCode service unavailable', 'upstream_stream_attempt']]) {
      expect(classifyLogLine(`2026-09-28T10:00:00Z [warn] Message stream WS proxy error: ${message === 'terminated' ? 'TypeError' : 'Error'}: ${message}`, 'web')).toEqual({
        at: Date.parse('2026-09-28T10:00:00Z'), source: 'message-stream WS', action: 'warning: upstream event stream failed',
        detail: `route=/api/event function=createUpstreamSseReader stage=${stage} message="${message}"`,
      });
      expect(classifyLogLine(`2026-09-28T10:00:00Z [warn] [PushWatcher] disconnected ${message}`, 'web')).toEqual({
        at: Date.parse('2026-09-28T10:00:00Z'), source: 'PushWatcher', action: 'warning: upstream event stream failed',
        detail: `route=/api/event function=createUpstreamSseReader stage=${stage} message="${message}"`,
      });
    }
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [error] [electron] autoUpdater error Error: Cannot find latest-mac.yml in the latest release artifacts (https://secret-123@example.test/private?token=secret-456): HttpError: 404 ', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'electron', action: 'error: updater error',
      detail: 'message="Cannot find latest-mac.yml in the latest release artifacts" http=404',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [info] private="[proxy] OpenCode proxy error: connect ECONNREFUSED"', 'web')).toBeNull();
    expect(classifyLogLine('[2026-09-28 10:00:00.000] [error] GET /private/secret-123?token=secret-456 - 404 with id 00000000:00000000:00000000:00000000 in 20ms', 'desktop')).toEqual({
      at: Date.parse('2026-09-28T10:00:00'), source: 'desktop', action: 'error: http request failed', detail: 'method=GET route=/other http=404',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [error] POST /api/session/secret-123?directory=/private/file - 503 with id 00000000:00000000:00000000:00000000 in 20ms', 'web')).toEqual({
      at: Date.parse('2026-09-28T10:00:00Z'), source: 'web', action: 'error: http request failed', detail: 'method=POST route=/api/other http=503',
    });
    expect(classifyLogLine('2026-09-28T10:00:00Z [lifecycle] monitor health check failed (2/3) class=timeout password=secret-123', 'web')).toEqual({
      at: Date.parse('2026-09-28T10:00:00Z'), source: 'lifecycle',
      action: 'info: health check failed', detail: 'attempt=2/3 class=timeout',
    });
  });

  it('groups repeated failed HTTP access records while retaining other errors and distinct bursts', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-diagnostics-'));
    try {
      const folder = path.join(home, 'Library', 'Logs', 'OpenChamber');
      await fs.mkdir(folder, { recursive: true });
      const start = Date.parse('2026-09-28T10:00:00Z');
      const access = (at, status = 404) => `[${new Date(at).toISOString()}] [error] GET /private/secret-123?token=secret-456 - ${status} with id 00000000:00000000:00000000:00000000 in 20ms`;
      const lines = [access(start), access(start + 1_000),
        '[2026-09-28T10:00:02.000Z] [error] [electron] autoUpdater error Bearer secret-789',
        access(start + 3_000, 503), access(start + 4_000), access(start + 11 * 60_000)];
      await fs.writeFile(path.join(folder, 'main.log'), `${lines.join('\n')}\n`);
      const result = await collectLocalFileDiagnostics({
        electronLogPath: path.join(folder, 'main.log'), home,
        env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, journal: createServerDiagnosticJournal(),
      });
      expect(result.events).toEqual([
        { at: start, source: 'desktop', action: 'error: http request failed', detail: 'method=GET route=/other http=404 count=3 spanMs=4000' },
        { at: start + 2_000, source: 'electron', action: 'error: updater error' },
        { at: start + 3_000, source: 'desktop', action: 'error: http request failed', detail: 'method=GET route=/other http=503' },
        { at: start + 11 * 60_000, source: 'desktop', action: 'error: http request failed', detail: 'method=GET route=/other http=404' },
      ]);
      expect(JSON.stringify(result)).not.toMatch(/secret|token|private|00000000/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('groups each stream-failure reporter without hiding other warnings or later bursts', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-diagnostics-'));
    try {
      const folder = path.join(home, 'Library', 'Logs', 'OpenChamber');
      await fs.mkdir(folder, { recursive: true });
      const start = Date.parse('2026-09-28T10:00:00Z');
      const line = (at, body) => `[${new Date(at).toISOString()}] [warn] ${body}`;
      const ws = 'Message stream WS proxy error: TypeError: fetch failed';
      const watcher = '[PushWatcher] disconnected fetch failed';
      await fs.writeFile(path.join(folder, 'main.log'), [
        line(start, ws), line(start + 1, watcher), line(start + 2, ws),
        line(start + 3, '[PushWatcher] disconnected token=secret-123'),
        line(start + 4, watcher), line(start + 11 * 60_000, ws),
      ].join('\n'));
      const result = await collectLocalFileDiagnostics({
        electronLogPath: path.join(folder, 'main.log'), home,
        env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, journal: createServerDiagnosticJournal(),
      });
      const detail = 'route=/api/event function=createUpstreamSseReader stage=upstream_connect_or_read message="fetch failed"';
      expect(result.events).toEqual([
        { at: start, source: 'message-stream WS', action: 'warning: upstream event stream failed', detail: `${detail} count=2 spanMs=2` },
        { at: start + 1, source: 'PushWatcher', action: 'warning: upstream event stream failed', detail: `${detail} count=2 spanMs=3` },
        { at: start + 11 * 60_000, source: 'message-stream WS', action: 'warning: upstream event stream failed', detail },
      ]);
      expect(result.coverage.find((entry) => entry.source === 'desktop')).toMatchObject({ filtered: 1, warnings: 1 });
      expect(JSON.stringify(result)).not.toContain('secret-123');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reads only the current web port, ignores symlinks and marks omitted lines', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-diagnostics-'));
    try {
      const logs = path.join(home, 'data', 'logs');
      await fs.mkdir(logs, { recursive: true });
      await fs.writeFile(path.join(logs, 'openchamber-3001.log'), '2026-09-28T10:00:00Z [error] foreign instance\n');
      await fs.writeFile(path.join(logs, 'openchamber-3000.log'), '2026-09-28T10:00:00Z [error] failed token=secret-123\nsecret-123\n');
      const shared = path.join(home, '.local', 'share', 'opencode', 'log');
      await fs.mkdir(shared, { recursive: true });
      await fs.writeFile(path.join(shared, 'opencode.log'), '2026-09-28T10:00:00Z [error] shared secret-456\n');
      const journal = createServerDiagnosticJournal();
      const result = await collectLocalFileDiagnostics({ home, env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, webPort: 3000, journal });
      expect(result.events).toHaveLength(0);
      expect(result.coverage.find((entry) => entry.source === 'web')).toMatchObject({ filtered: 2, errors: 1 });
      expect(JSON.stringify(result)).not.toContain('secret-123');
      expect(JSON.stringify(result)).not.toContain('secret-456');
      expect(result.coverage.find((entry) => entry.source === 'managed OpenCode')?.status).toBe('unavailable');
      await fs.rename(path.join(logs, 'openchamber-3000.log'), path.join(logs, 'original.log'));
      await fs.symlink(path.join(logs, 'original.log'), path.join(logs, 'openchamber-3000.log'));
      const linked = await collectLocalFileDiagnostics({ home, env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, webPort: 3000, journal });
      expect(linked.events).toHaveLength(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('reports an existing file of unclassified info as filtered, not empty or successfully read', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-diagnostics-'));
    try {
      const folder = path.join(home, 'data', 'logs');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'openchamber-3000.log'), '2026-09-28T10:00:00Z [info] token=secret-123\n');
      const result = await collectLocalFileDiagnostics({
        home, env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, webPort: 3000,
        journal: createServerDiagnosticJournal(),
      });
      expect(result.events).toEqual([]);
      expect(result.coverage.find(({ source }) => source === 'web')).toEqual({ source: 'web', status: 'filtered', omitted: 0, filtered: 1 });
      expect(JSON.stringify(result)).not.toContain('secret-123');
      await fs.writeFile(path.join(folder, 'openchamber-3000.log'), '');
      const empty = await collectLocalFileDiagnostics({
        home, env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, webPort: 3000,
        journal: createServerDiagnosticJournal(),
      });
      expect(empty.coverage.find(({ source }) => source === 'web')?.status).toBe('empty');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('merges the process-local journal with known files in timestamp order', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-diagnostics-'));
    try {
      const at = Date.parse('2026-09-28T10:00:00Z');
      const journal = createServerDiagnosticJournal({ now: () => at });
      journal.beginManagedProcess(1);
      journal.recordManagedLine('timestamp=2026-09-28T10:00:00Z level=ERROR run=abcdef01 message="secret-123"');
      const folder = path.join(home, 'data', 'logs');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'openchamber-3000.log'), '2026-09-28T10:00:01Z [lifecycle] health check failed\n');
      const result = await collectLocalFileDiagnostics({ home, env: { OPENCHAMBER_DATA_DIR: path.join(home, 'data') }, webPort: 3000, journal });
      expect(result.events.map(({ source, action }) => [source, action])).toEqual([
        ['server journal', 'managed launch'],
        ['lifecycle', 'info: health check failed'],
      ]);
      expect(result.coverage.find(({ source }) => source === 'managed OpenCode')?.status).toBe('filtered');
      expect(JSON.stringify(result)).not.toContain('secret-123');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('joins local SSH manager history without host names, stderr, passwords or paths', () => {
    const at = 1781000000000;
    const result = collectSshBufferDiagnostics({
      entries: [{
        lines: [
          `[${at}] [INFO] phase="ready" detail=secret-123 host=private.example retry=0 requires_user_action=false`,
          `[${at + 1}] [ERROR] Connection failed for password=secret-456 at /private/file`,
          `[${at + 1}] [INFO] Not reusing the server on remote port 3099: it does not take this instance's UI password (auth status 401)`,
        ],
        phase: 'error', updatedAtMs: at + 2, retryAttempt: 1, requiresUserAction: true,
      }], omittedSources: 0,
    });
    expect(result.events).toEqual([
      { at, source: 'SSH connection 1', action: 'info: phase ready' },
      { at: at + 1, source: 'SSH connection 1', action: 'info: remote server authentication mismatch' },
      { at: at + 2, source: 'SSH connection 1', action: 'current phase error', detail: 'retry=1 userAction=true' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|password|private\.example|private\/file/);
    expect(result.coverage[0]).toMatchObject({ filtered: 1, errors: 1 });
    expect(classifySshLogLine(`[${at}] [INFO] phase="injected-secret"`, 'SSH connection 1')).toBeNull();
    expect(classifySshLogLine(`[${at}] [INFO] token=secret-789 connection`, 'SSH connection 1')).toBeNull();
  });

  it('keeps the latest SSH events when the local buffer exceeds the export cap', () => {
    const lines = Array.from({ length: 8_001 }, (_, index) => `[${1781000000000 + index}] [INFO] Starting SSH connection`);
    const result = collectSshBufferDiagnostics({ entries: [{ lines }], omittedSources: 0 });
    expect(result.events).toHaveLength(8_000);
    expect(result.events[0].at).toBe(1781000000001);
    expect(result.coverage).toEqual([{ source: 'local SSH manager', status: 'truncated', omitted: 1, filtered: 0 }]);
  });

  it('counts filtered SSH info lines rather than reporting them as a successful read', () => {
    const result = collectSshBufferDiagnostics({
      entries: [{ lines: ['[1781000000000] [INFO] private output'], phase: 'secret', updatedAtMs: 1781000000000 }],
      omittedSources: 0,
    });
    expect(result.events).toEqual([]);
    expect(result.coverage).toEqual([{ source: 'local SSH manager', status: 'filtered', omitted: 0, filtered: 1 }]);
  });
});
