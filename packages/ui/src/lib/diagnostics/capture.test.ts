import { describe, expect, test } from 'bun:test';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { isLocalDiagnosticRuntime, startDiagnosticCapture } from './capture';
import { buildDiagnosticLog, parseFileDiagnostics } from './export';
import { clearDiagnosticEvents, formatDiagnosticEvents, getDiagnosticEvents, recordDiagnosticEvent } from './timeline';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { recordSessionError } from '@/sync/session-error-log';
import { recordSendFailure } from '@/sync/send-failure-log';

describe('local diagnostic runtime', () => {
  test('rejects a remote runtime, including one forwarded to another loopback port', () => {
    const originalWindow = globalThis.window;
    const originalResolver = getRuntimeUrlResolver();
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/' },
          __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3000',
        },
      });
      setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3000' }));
      expect(isLocalDiagnosticRuntime()).toBe(true);
      setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:4000' }));
      expect(isLocalDiagnosticRuntime()).toBe(false);
      setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'https://remote.example' }));
      expect(isLocalDiagnosticRuntime()).toBe(false);
    } finally {
      setRuntimeUrlResolver(originalResolver);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('exports no buffered local events while a remote runtime is active', async () => {
    const originalWindow = globalThis.window;
    const originalResolver = getRuntimeUrlResolver();
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/' },
          __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3000',
        },
      });
      setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:4000' }));
      clearDiagnosticEvents();
      recordDiagnosticEvent({ at: Date.now(), source: 'private', action: 'private data' });
      const output = await buildDiagnosticLog();
      expect(output.includes('skipped (active runtime is not the local instance)')).toBe(true);
      expect(output.includes('private')).toBe(false);
      expect(output.includes('Events (0)')).toBe(true);
    } finally {
      clearDiagnosticEvents();
      setRuntimeUrlResolver(originalResolver);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('labels selections and correlates failures without copying IDs, paths or error text', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalResolver = getRuntimeUrlResolver();
    const originalFetch = globalThis.fetch;
    const originalSession = useSessionUIStore.getState().currentSessionId;
    const originalDirectory = useDirectoryStore.getState().currentDirectory;
    let stop = () => {};
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/' },
          __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3000',
          addEventListener: () => {}, removeEventListener: () => {},
        },
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true, value: { addEventListener: () => {}, removeEventListener: () => {} },
      });
      setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3000' }));
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/health') return Response.json({ openCodeRunning: true, isOpenCodeReady: true });
        if (url.pathname === '/api/diagnostics/local-files') return Response.json({ events: [], coverage: [] });
        return Response.json({});
      };
      clearDiagnosticEvents();
      useSessionUIStore.setState({ currentSessionId: 'ses_privateA' });
      useDirectoryStore.setState({ currentDirectory: '/private/path-A' });
      stop = startDiagnosticCapture();
      useSessionUIStore.setState({ currentSessionId: 'ses_privateB' });
      useDirectoryStore.setState({ currentDirectory: '/private/path-B' });
      useSessionUIStore.setState({ currentSessionId: 'ses_privateA' });
      useSessionUIStore.setState({ currentSessionId: null });
      const selections = formatDiagnosticEvents(getDiagnosticEvents());
      expect(selections).toContain('session selection snapshot session-1');
      expect(selections).toContain('directory selection snapshot directory-1');
      expect(selections).toContain('session changed from=session-1 to=session-2');
      expect(selections).toContain('session changed from=session-2 to=session-1');
      expect(selections).toContain('session changed from=session-1 to=none');
      expect(selections).toContain('directory changed from=directory-1 to=directory-2');

      recordSessionError({ sessionId: 'ses_privateB', directory: '/private/path-B', name: 'APIError', message: 'Bearer error-secret' });
      recordSendFailure({ sessionId: 'ses_privateB', messageId: 'msg_privateC', directory: '/private/path-B', status: 503,
        ambiguous: false, confirmationChecked: true, reason: 'Bearer send-secret' });
      const output = await buildDiagnosticLog();
      expect(output).toContain('[session.error] turn failed session=session-2 directory=directory-2 type=APIError');
      expect(output).toContain('[send] rejected session=session-2 message=message-1 directory=directory-2 status=503 ambiguous=false confirmationChecked=true');
      expect(/ses_private|msg_private|\/private\/path|Bearer|error-secret|send-secret/.test(output)).toBe(false);
    } finally {
      stop();
      useSessionUIStore.setState({ currentSessionId: originalSession });
      useDirectoryStore.setState({ currentDirectory: originalDirectory });
      clearDiagnosticEvents();
      globalThis.fetch = originalFetch;
      setRuntimeUrlResolver(originalResolver);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  test('drops malformed IPC/HTTP records while preserving valid local events', () => {
    const safe = { at: 1781000000000, source: 'SSH connection 1', action: 'info: phase ready' };
    const payload = parseFileDiagnostics({
      events: [safe, { ...safe, action: 'info: password=secret-123' }],
      coverage: [{ source: 'local SSH manager', status: 'read' }, { source: 'token=secret-456', status: 'read' },
        { source: 'web', status: 'filtered', filtered: 1, errors: 'secret-789' }],
    });
    expect(payload?.events).toEqual([safe]);
    expect(payload?.coverage).toEqual([
      { source: 'local SSH manager', status: 'read' },
      { source: 'diagnostic transport', status: 'invalid records omitted', omitted: 3 },
    ]);
    expect(JSON.stringify(payload).includes('secret')).toBe(false);
  });

  test('accepts the server journal and classified managed stderr but rejects raw child output', () => {
    const at = Date.now();
    const payload = parseFileDiagnostics({
      events: [
        { at, source: 'server journal', action: 'managed launch', detail: 'attempt=1' },
        { at, source: 'managed OpenCode', action: 'info: cli starting' },
        { at, source: 'managed OpenCode', action: 'error: password=secret-123' },
        { at, source: 'managed OpenCode', action: 'error: unclassified output', detail: 'token=secret-456' },
      ],
      coverage: [{ source: 'managed OpenCode', status: 'truncated', omitted: 1, filtered: 2, warnings: 1, errors: 1 }],
    });
    expect(payload.events).toHaveLength(2);
    expect(payload.coverage).toEqual([
      { source: 'managed OpenCode', status: 'truncated', omitted: 1, filtered: 2, warnings: 1, errors: 1 },
      { source: 'diagnostic transport', status: 'invalid records omitted', omitted: 2 },
    ]);
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  test('accepts only fixed proxy failure detail from local files', () => {
    const at = Date.now();
    const result = parseFileDiagnostics({
      events: [
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'class=connection_refused' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'class=connection_refused message="connect ECONNREFUSED [address]"' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=POST route=/api/session/:sessionID/message function=onApiProxyError class=connection_refused' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=POST route=/api/session/:sessionID/prompt function=onApiProxyError class=timeout' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=GET route=/api/session function=forwardSanitizedSessionListRequest class=connection_refused message="fetch failed" cause="connect ECONNREFUSED [address]"' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'url=/private/file token=secret-123' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=GET route=/api/session/secret-123 function=onApiProxyError class=error' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=GET route=/api/info function=secret-456 class=error' },
        { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=GET route=/api/info function=onApiProxyError class=error message="Bearer secret-789"' },
      ],
      coverage: [],
    });
    expect(result.events).toEqual([
      { at, source: 'proxy', action: 'error: api proxy failed', detail: 'class=connection_refused' },
      { at, source: 'proxy', action: 'error: api proxy failed', detail: 'class=connection_refused message="connect ECONNREFUSED [address]"' },
      { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=POST route=/api/session/:sessionID/message function=onApiProxyError class=connection_refused' },
      { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=POST route=/api/session/:sessionID/prompt function=onApiProxyError class=timeout' },
      { at, source: 'proxy', action: 'error: api proxy failed', detail: 'method=GET route=/api/session function=forwardSanitizedSessionListRequest class=connection_refused message="fetch failed" cause="connect ECONNREFUSED [address]"' },
    ]);
    expect(result.coverage).toEqual([{ source: 'diagnostic transport', status: 'invalid records omitted', omitted: 4 }]);
    expect(/secret|private/.test(JSON.stringify(result))).toBe(false);
  });

  test('accepts bounded failed HTTP request bursts without accepting private paths or invented sources', () => {
    const at = Date.now();
    const request = { at, source: 'desktop', action: 'error: http request failed' };
    const result = parseFileDiagnostics({
      events: [
        { ...request, detail: 'method=GET route=/other http=404 count=3645 spanMs=600000' },
        { ...request, source: 'web', detail: 'method=POST route=/api/session http=503' },
        { ...request, detail: 'method=GET route=/private/secret-123 http=404 count=2 spanMs=1000' },
        { ...request, detail: 'method=GET route=/other http=404 count=4001 spanMs=1000' },
        { ...request, detail: 'method=GET route=/other http=404 count=2 spanMs=600001' },
        { ...request, source: 'proxy', detail: 'method=GET route=/other http=404' },
        { ...request, detail: 'method=GET route=/other http=404 count=2 spanMs=1000 token=secret-456' },
      ], coverage: [],
    });
    expect(result.events).toEqual([
      { ...request, detail: 'method=GET route=/other http=404 count=3645 spanMs=600000' },
      { ...request, source: 'web', detail: 'method=POST route=/api/session http=503' },
    ]);
    expect(result.coverage).toEqual([{ source: 'diagnostic transport', status: 'invalid records omitted', omitted: 5 }]);
    expect(/secret|private/.test(JSON.stringify(result))).toBe(false);
  });

  test('accepts completed HTTP statuses only from the server journal with a fixed stage and safe route', () => {
    const at = Date.now();
    const event = { at, source: 'server journal', action: 'http response completed',
      detail: 'method=GET route=/api/session/:sessionID stage=downstream_response http=404 count=120 spanMs=1190' };
    const result = parseFileDiagnostics({ events: [
      event,
      { ...event, detail: 'method=POST route=/api/session/:sessionID/message stage=downstream_response http=503' },
      { ...event, source: 'desktop' },
      { ...event, detail: 'method=GET route=/api/session/private stage=downstream_response http=404' },
      { ...event, detail: `${event.detail} token=secret-123` },
      { ...event, detail: 'method=GET route=/api/session/:sessionID stage=upstream_connect http=404' },
      { ...event, detail: 'method=GET route=/api/other stage=downstream_response http=200' },
    ], coverage: [] });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual(event);
    expect(result.coverage).toEqual([{ source: 'diagnostic transport', status: 'invalid records omitted', omitted: 5 }]);
    expect(/secret|private/.test(JSON.stringify(result))).toBe(false);
  });

  test('accepts only known stream reporters with bounded retry detail', () => {
    const at = Date.now();
    const detail = 'route=/api/event function=createUpstreamSseReader stage=upstream_connect_or_read message="fetch failed"';
    const ws = { at, source: 'message-stream WS', action: 'warning: upstream event stream failed', detail: `${detail} count=55 spanMs=13745` };
    const watcher = { at, source: 'PushWatcher', action: 'warning: upstream event stream failed', detail };
    const result = parseFileDiagnostics({
      events: [
        ws, watcher,
        { ...watcher, detail: 'route=/api/event function=createUpstreamSseReader stage=upstream_connect_or_read message="terminated"' },
        { ...ws, detail: 'route=/api/event function=createUpstreamSseReader stage=upstream_stream_attempt message="OpenCode service unavailable"' },
        { ...ws, detail: 'route=/api/event function=createUpstreamSseReader stage=upstream_connect_or_read message="OpenCode service unavailable"' },
        { ...ws, source: 'desktop' },
        { ...watcher, action: 'warning: unclassified output' },
        { ...ws, detail: `${detail} count=4001 spanMs=1000` },
        { ...ws, detail: `${detail} count=2 spanMs=600001` },
        { ...ws, detail: `${detail} token=secret-123` },
        { ...ws, detail: 'route=/api/event?token=secret-456 function=createUpstreamSseReader stage=upstream_connect_or_read message="fetch failed"' },
      ], coverage: [],
    });
    expect(result.events).toEqual([
      ws, watcher,
      { ...watcher, detail: 'route=/api/event function=createUpstreamSseReader stage=upstream_connect_or_read message="terminated"' },
      { ...ws, detail: 'route=/api/event function=createUpstreamSseReader stage=upstream_stream_attempt message="OpenCode service unavailable"' },
    ]);
    expect(result.coverage).toEqual([{ source: 'diagnostic transport', status: 'invalid records omitted', omitted: 7 }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('retains a known updater message without accepting arbitrary updater URLs', () => {
    const at = Date.now();
    const known = { at, source: 'electron', action: 'error: updater error', detail: 'message="Cannot find latest-mac.yml in the latest release artifacts" http=404' };
    const result = parseFileDiagnostics({ events: [
      known,
      { ...known, detail: 'message="Cannot find latest-mac.yml in the latest release artifacts" url=https://example.test/private?token=secret-123' },
      { ...known, source: 'desktop' },
    ], coverage: [] });
    expect(result.events).toEqual([known]);
    expect(result.coverage).toEqual([{ source: 'diagnostic transport', status: 'invalid records omitted', omitted: 2 }]);
    expect(JSON.stringify(result).includes('secret')).toBe(false);
  });

  test('keeps filtered coverage while rejecting invented managed log categories', () => {
    const at = Date.now();
    const result = parseFileDiagnostics({
      events: [
        { at, source: 'managed OpenCode', action: 'info: database bootstrap completed' },
        { at, source: 'managed OpenCode', action: 'info: watcher activity', detail: 'subscribed=17 started=16 spanMs=9000' },
        { at, source: 'managed OpenCode', action: 'info: watcher activity', detail: 'directory=secret-123' },
        { at, source: 'managed OpenCode', action: 'info: password' },
        { at, source: 'managed OpenCode', action: 'info: subprocess spawned', detail: 'count=20 spanMs=9500' },
        { at, source: 'managed OpenCode', action: 'info: subprocess spawned', detail: 'command=secret-456' },
        { at, source: 'relay-identity', action: 'warning: relay signing key generated' },
      ],
      coverage: [{ source: 'managed OpenCode', status: 'read', filtered: 123 }],
    });
    expect(result.events).toEqual([
      { at, source: 'managed OpenCode', action: 'info: database bootstrap completed' },
      { at, source: 'managed OpenCode', action: 'info: watcher activity', detail: 'subscribed=17 started=16 spanMs=9000' },
      { at, source: 'managed OpenCode', action: 'info: subprocess spawned', detail: 'count=20 spanMs=9500' },
      { at, source: 'relay-identity', action: 'warning: relay signing key generated' },
    ]);
    expect(result.coverage).toEqual([
      { source: 'managed OpenCode', status: 'read', filtered: 123 },
      { source: 'diagnostic transport', status: 'invalid records omitted', omitted: 3 },
    ]);
  });

  test('exports a current health snapshot and timed probes without copying health bodies', async () => {
    const originalWindow = globalThis.window;
    const originalResolver = getRuntimeUrlResolver();
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/' },
          __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3000',
        },
      });
      setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3000' }));
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/health') return Response.json({
          openCodeRunning: true, isOpenCodeReady: false, openCodePort: 5001,
          openCodeSecureConnection: true, opencodeViaWsl: false,
          lastOpenCodeError: 'Bearer secret-123 /private/file',
        });
        if (url.pathname === '/api/diagnostics/local-files') return Response.json({
          events: [{ at: Date.now(), source: 'proxy', action: 'error: api proxy failed', detail: 'method=GET route=/api/info function=onApiProxyError class=connection_refused message="connect ECONNREFUSED [address]"' }],
          coverage: [],
        });
        return Response.json({ message: 'secret-456' });
      };
      clearDiagnosticEvents();
      const output = await buildDiagnosticLog();
      expect(output).toContain('Current health: HTTP 200, OpenCode running=true, ready=false, secure=true, port=5001, WSL=false');
      expect(output).toContain('[server] health probe http=200 timeMs=');
      expect(output).toContain('[OpenCode API] info probe method=GET route=/api/info function=probeOpenCode http=200 content=json timeMs=');
      expect(output).toContain('[proxy] error: api proxy failed method=GET route=/api/info function=onApiProxyError class=connection_refused message="connect ECONNREFUSED [address]"');
      expect(output.split('[server] health probe').length - 1).toBe(1);
      expect(output).not.toContain('secret');
      expect(output).not.toContain('/private/file');

      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/health') return new Response('Bearer secret-789', { status: 503 });
        if (url.pathname === '/api/diagnostics/local-files') return Response.json({ events: [], coverage: [] });
        return Response.json({});
      };
      const failed = await buildDiagnosticLog();
      expect(failed).toContain('Current health: unavailable (health request failed or response invalid)');
      expect(failed).toContain('[server] health probe http=503 timeMs=');
      expect(failed).not.toContain('secret-789');

      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/health') return Response.json({ privateValue: 'secret-999' });
        if (url.pathname === '/api/diagnostics/local-files') return Response.json({ events: [], coverage: [] });
        return new Response('<html>wrong service</html>', { headers: { 'content-type': 'text/html' } });
      };
      const invalid = await buildDiagnosticLog();
      expect(invalid).toContain('Current health: unavailable (health request failed or response invalid)');
      expect(invalid).toContain('[server] health response invalid');
      expect(invalid).toContain('[OpenCode API] info probe method=GET route=/api/info function=probeOpenCode http=200 content=html timeMs=');
      expect(invalid).not.toContain('secret-999');
    } finally {
      clearDiagnosticEvents();
      globalThis.fetch = originalFetch;
      setRuntimeUrlResolver(originalResolver);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});
