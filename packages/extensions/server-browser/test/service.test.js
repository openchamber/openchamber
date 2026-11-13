import { describe, expect, test } from 'bun:test';
import { InspectorError } from '../src/inspector.js';
import { createService } from '../src/service.js';

const TOKEN = 'test-service-token';
const authorization = { authorization: `Bearer ${TOKEN}` };

const createRuntime = () => {
  const calls = [];
  return {
    calls,
    agentActive: true,
    async perform(action, parameters, signal, context) {
      calls.push(['perform', action, parameters, context]);
      return { url: 'https://example.test', title: 'Example' };
    },
    state() {
      return {
        controller: 'none',
        selectedScopeId: '["/repo","ses_1"]',
        generation: 1,
        scopes: [{
          id: '["/repo","ses_1"]', directory: '/repo', sessionId: 'ses_1', selected: true,
          url: 'https://example.test', title: 'Example',
          nativeSelectCompatibility: false, nativeSelectCompatibilityError: '',
        }],
      };
    },
    async selectScope(id, generation) { calls.push(['select', id, generation]); },
    async navigate(url, generation) { calls.push(['navigate', url, generation]); },
    async reload(generation) { calls.push(['reload', generation]); },
    async inspectorStart() { calls.push(['inspector-start']); return { captureId: 'cap-1' }; },
    inspectorEvents(captureId, after) {
      calls.push(['inspector-events', captureId, after]);
      if (captureId !== 'cap-1') throw new InspectorError('CAPTURE_GONE');
      return { cursor: after, more: false, console: [], network: [] };
    },
    async inspectorEvaluate(captureId, expression) { calls.push(['inspector-evaluate', captureId, expression]); return { text: '2', isError: false, truncated: false }; },
    async openScope(scope, generation) { calls.push(['open-scope', scope, generation]); },
    setViewerTheme(theme) { calls.push(['theme', theme]); },
    async setDevicePixelRatio(ratio) { calls.push(['ratio', ratio]); },
    async setViewport(viewport, generation) { calls.push(['viewport', viewport, generation]); },
    async newTab(generation) { calls.push(['tab-new', generation]); },
    async selectTab(tabId, generation) { calls.push(['tab-select', tabId, generation]); },
    async closeTab(tabId, generation) { calls.push(['tab-close', tabId, generation]); },
    async stop(generation) { calls.push(['stop', generation]); },
    async back(generation) { calls.push(['back', generation]); },
    async forward(generation) { calls.push(['forward', generation]); },
    async setNativeSelectCompatibility(enabled, generation) { calls.push(['select-compatibility', enabled, generation]); },
    async surfaceFrame(request) {
      calls.push(['frame', request.after, request.wait]);
      return { sequence: 4, bytes: Buffer.from('jpeg'), mime: 'image/jpeg', width: 800, height: 600, title: 'Frame 😀\nTitle' };
    },
    async surfaceInput(events) { calls.push(['input', events]); },
    async surfaceControl(controller) { calls.push(['control', controller]); },
    async surfaceResize(size) { calls.push(['resize', size]); return size; },
    async surfaceClipboard() { calls.push(['clipboard']); return 'copied'; },
    async close() { calls.push(['close']); },
  };
};

const startFixture = async (runtime = createRuntime()) => {
  const service = createService({ runtime, token: TOKEN, port: 0 });
  const address = await service.listen();
  return { runtime, service, origin: `http://${address.host}:${address.port}` };
};

describe('server browser service', () => {
  test('requires the bearer token on every service endpoint', async () => {
    const fixture = await startFixture();
    try {
      const requests = [
        ['/health', { method: 'GET' }],
        ['/browser-control', { method: 'POST', body: '{}' }],
        ['/surface/frame?after=0&wait=0', { method: 'GET' }],
        ['/surface/input', { method: 'POST', body: '{}' }],
        ['/surface/control', { method: 'POST', body: '{}' }],
        ['/surface/resize', { method: 'POST', body: '{}' }],
        ['/surface/clipboard', { method: 'GET' }],
      ];

      const responses = await Promise.all(requests.map(([path, init]) => fetch(`${fixture.origin}${path}`, init)));

      expect(responses.map((response) => response.status)).toEqual(requests.map(() => 401));
      expect(fixture.runtime.calls).toEqual([]);
    } finally {
      await fixture.service.close();
    }
  });

  test('dispatches SDK browser and surface protocol requests', async () => {
    const fixture = await startFixture();
    try {
      const health = await fetch(`${fixture.origin}/health`, { headers: authorization });
      const browser = await fetch(`${fixture.origin}/browser-control`, {
        method: 'POST', headers: authorization,
        body: JSON.stringify({
          requestId: 'browser-1',
          action: 'browser.back',
          parameters: {},
          context: { directory: '/repo', sessionId: 'ses_1' },
        }),
      });
      const input = await fetch(`${fixture.origin}/surface/input`, {
        method: 'POST', headers: authorization,
        body: JSON.stringify({ events: [{ type: 'text', text: 'hello' }] }),
      });
      const control = await fetch(`${fixture.origin}/surface/control`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ controller: 'user' }),
      });
      const resize = await fetch(`${fixture.origin}/surface/resize`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ width: 640, height: 480 }),
      });
      const clipboard = await fetch(`${fixture.origin}/surface/clipboard`, { headers: authorization });
      const frame = await fetch(`${fixture.origin}/surface/frame?after=2&wait=25`, { headers: authorization });

      expect(health.status).toBe(200);
      expect(await browser.json()).toEqual({ ok: true, data: { url: 'https://example.test', title: 'Example' } });
      expect(input.status).toBe(204);
      expect(control.status).toBe(204);
      expect(await resize.json()).toEqual({ width: 640, height: 480 });
      expect(await clipboard.json()).toEqual({ text: 'copied' });
      expect(frame.headers.get('x-surface-seq')).toBe('4');
      expect(frame.headers.get('x-surface-agent-active')).toBe('1');
      expect(frame.headers.get('x-surface-title')).toBe('Frame ? Title');
      expect(await frame.text()).toBe('jpeg');
      expect(fixture.runtime.calls.slice(0, 6).map((call) => call[0])).toEqual([
        'perform', 'input', 'control', 'resize', 'clipboard', 'frame',
      ]);
      expect(fixture.runtime.calls[0][3]).toEqual({ directory: '/repo', sessionId: 'ses_1' });
    } finally {
      await fixture.service.close();
    }
  });

  test('serves dock state and serializes scope and navigation commands', async () => {
    // Given a running service with one browser scope.
    const fixture = await startFixture();
    try {
      // When the dock reads state, selects the scope, and navigates history.
      const state = await fetch(`${fixture.origin}/browser/state`, { headers: authorization });
      const select = await fetch(`${fixture.origin}/browser/select`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ scopeId: '["/repo","ses_1"]', generation: 1 }),
      });
      const navigate = await fetch(`${fixture.origin}/browser/navigate`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ url: 'https://next.test', generation: 1 }),
      });
      const back = await fetch(`${fixture.origin}/browser/back`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1 }),
      });
      const forward = await fetch(`${fixture.origin}/browser/forward`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1 }),
      });

      // Then each official service route returns state and invokes the matching manager operation.
      expect(state.status).toBe(200);
      expect((await state.json()).selectedScopeId).toBe('["/repo","ses_1"]');
      expect([select.status, navigate.status, back.status, forward.status]).toEqual([200, 200, 200, 200]);
      expect(fixture.runtime.calls.slice(0, 4)).toEqual([
        ['select', '["/repo","ses_1"]', 1],
        ['navigate', 'https://next.test', 1],
        ['back', 1],
        ['forward', 1],
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('adds a scheme to typed dock addresses', async () => {
    // Given a running service.
    const fixture = await startFixture();
    try {
      // When the dock navigates to addresses typed with and without a scheme.
      for (const url of ['192.168.1.20:3100/app', 'localhost:5173', '[::1]:8080', 'example.com/docs', 'http://plain.test']) {
        await fetch(`${fixture.origin}/browser/navigate`, {
          method: 'POST', headers: authorization, body: JSON.stringify({ url, generation: 1 }),
        });
      }

      // Then IPs and localhost use HTTP, other hosts use HTTPS, and explicit schemes are kept.
      expect(fixture.runtime.calls.map(([, url]) => url)).toEqual([
        'http://192.168.1.20:3100/app',
        'http://localhost:5173',
        'http://[::1]:8080',
        'https://example.com/docs',
        'http://plain.test',
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('rejects malformed dock requests before invoking the manager', async () => {
    // Given a running service.
    const fixture = await startFixture();
    try {
      // When dock commands omit their required string, then the service refuses both.
      const responses = await Promise.all([
        fetch(`${fixture.origin}/browser/select`, { method: 'POST', headers: authorization, body: '{}' }),
        fetch(`${fixture.origin}/browser/navigate`, { method: 'POST', headers: authorization, body: '{"url":7}' }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([400, 400]);
      expect(fixture.runtime.calls).toEqual([]);
    } finally {
      await fixture.service.close();
    }
  });

  test('rejects malformed protocol bodies before invoking the runtime', async () => {
    const fixture = await startFixture();
    try {
      const responses = await Promise.all([
        fetch(`${fixture.origin}/browser-control`, { method: 'POST', headers: authorization, body: '{}' }),
        fetch(`${fixture.origin}/surface/input`, { method: 'POST', headers: authorization, body: '{"events":[{}]}' }),
        fetch(`${fixture.origin}/surface/control`, { method: 'POST', headers: authorization, body: '{"controller":"root"}' }),
        fetch(`${fixture.origin}/surface/resize`, { method: 'POST', headers: authorization, body: '{"width":0,"height":1}' }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
      expect(fixture.runtime.calls).toEqual([]);
    } finally {
      await fixture.service.close();
    }
  });

  test('aborts a bounded frame wait when the service closes', async () => {
    const started = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const runtime = createRuntime();
    runtime.surfaceFrame = ({ signal }) => new Promise((resolve, reject) => {
      started.resolve();
      signal.addEventListener('abort', () => {
        aborted.resolve();
        reject(signal.reason);
      }, { once: true });
    });
    const fixture = await startFixture(runtime);
    const pending = fetch(`${fixture.origin}/surface/frame?after=0&wait=25000`, { headers: authorization });

    await started.promise;
    await fixture.service.close();

    await aborted.promise;
    const response = await pending.catch(() => null);
    if (response) expect(response.status).toBe(500);
    expect(runtime.calls.at(-1)[0]).toBe('close');
  });

  test('dock reload and stop require a generation and invoke their operations', async () => {
    const fixture = await startFixture();
    try {
      const invalid = await fetch(`${fixture.origin}/browser/reload`, {
        method: 'POST', headers: authorization, body: '{}',
      });
      expect(invalid.status).toBe(400);
      const reload = await fetch(`${fixture.origin}/browser/reload`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1 }),
      });
      const stop = await fetch(`${fixture.origin}/browser/stop`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1 }),
      });
      expect(reload.status).toBe(200);
      expect(stop.status).toBe(200);
      expect(fixture.runtime.calls).toEqual([['reload', 1], ['stop', 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('native select compatibility route parses a boolean and uses dock generation', async () => {
    // Given a running service and the selected browser generation.
    const fixture = await startFixture();
    try {
      // When invalid and valid compatibility requests arrive.
      const invalid = await fetch(`${fixture.origin}/browser/select-compatibility`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ enabled: 'yes', generation: 1 }),
      });
      const enabled = await fetch(`${fixture.origin}/browser/select-compatibility`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ enabled: true, generation: 1 }),
      });

      // Then malformed input is rejected and the valid mutation reaches the manager once.
      expect(invalid.status).toBe(400);
      expect(enabled.status).toBe(200);
      expect(fixture.runtime.calls).toEqual([['select-compatibility', true, 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('answers no content when nothing was copied so the viewer keeps its clipboard', async () => {
    const runtime = createRuntime();
    runtime.surfaceClipboard = async () => '';
    const fixture = await startFixture(runtime);
    try {
      const clipboard = await fetch(`${fixture.origin}/surface/clipboard`, { headers: authorization });

      expect(clipboard.status).toBe(204);
      expect(await clipboard.text()).toBe('');
    } finally {
      await fixture.service.close();
    }
  });

  test('dock tab routes validate their fields and reach the manager', async () => {
    const fixture = await startFixture();
    try {
      const post = (path, body) => fetch(`${fixture.origin}${path}`, {
        method: 'POST', headers: authorization, body: JSON.stringify(body),
      });

      const missingTab = await post('/browser/tabs/select', { generation: 1 });
      const unknown = await post('/browser/tabs/move', { generation: 1, tabId: 'tab-2' });
      const created = await post('/browser/tabs/new', { generation: 1 });
      const selected = await post('/browser/tabs/select', { generation: 1, tabId: 'tab-2' });
      const closed = await post('/browser/tabs/close', { generation: 1, tabId: 'tab-2' });

      expect(missingTab.status).toBe(400);
      expect(unknown.status).toBe(404);
      expect([created.status, selected.status, closed.status]).toEqual([200, 200, 200]);
      expect(fixture.runtime.calls).toEqual([['tab-new', 1], ['tab-select', 'tab-2', 1], ['tab-close', 'tab-2', 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('validates viewer ratio and viewport requests at the service boundary', async () => {
    const fixture = await startFixture();
    try {
      const post = (path, body) => fetch(`${fixture.origin}${path}`, {
        method: 'POST', headers: authorization, body: JSON.stringify(body),
      });

      const badRatio = await post('/browser/viewer', { devicePixelRatio: 'x' });
      const ratio = await post('/browser/viewer', { devicePixelRatio: 1.5 });
      const missingMobile = await post('/browser/viewport', { generation: 1, mode: 'auto' });
      const tooWide = await post('/browser/viewport', { generation: 1, mode: 'fixed', width: 4000, height: 800, mobile: false });
      const fixed = await post('/browser/viewport', { generation: 1, mode: 'fixed', width: 800, height: 600, mobile: true, source: 'agent' });

      expect([badRatio.status, ratio.status, missingMobile.status, tooWide.status, fixed.status]).toEqual([400, 200, 400, 400, 200]);
      expect(fixture.runtime.calls).toEqual([
        ['ratio', 1.5],
        ['viewport', { mode: 'fixed', width: 800, height: 600, mobile: true }, 1],
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('accepts the host theme for the page menu and rejects an unknown mode', async () => {
    const fixture = await startFixture();
    try {
      const post = (path, body) => fetch(`${fixture.origin}${path}`, {
        method: 'POST', headers: authorization, body: JSON.stringify(body),
      });

      const badMode = await post('/browser/viewer', { theme: { mode: 'sepia' } });
      const empty = await post('/browser/viewer', {});
      const themed = await post('/browser/viewer', { theme: { mode: 'dark', elevated: '#101010' } });

      expect([badMode.status, empty.status, themed.status]).toEqual([400, 400, 200]);
      expect(fixture.runtime.calls).toEqual([['theme', { dark: true, properties: { '--menu-background': '#101010' } }]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('opens a chat scope for the dock only with a complete, bounded context', async () => {
    const fixture = await startFixture();
    try {
      const post = (path, body) => fetch(`${fixture.origin}${path}`, {
        method: 'POST', headers: authorization, body: JSON.stringify(body),
      });

      const missing = await post('/browser/scope', { directory: '/repo', generation: 1 });
      const oversized = await post('/browser/scope', { directory: '/repo', sessionId: 's'.repeat(257), generation: 1 });
      const opened = await post('/browser/scope', { directory: '/repo', sessionId: 'ses_1', generation: 1 });

      expect([missing.status, oversized.status, opened.status]).toEqual([400, 400, 200]);
      expect(fixture.runtime.calls).toEqual([['open-scope', { directory: '/repo', sessionId: 'ses_1' }, 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('routes inspector calls with validated identities and reports failures as codes', async () => {
    const fixture = await startFixture();
    try {
      const post = (path, body) => fetch(`${fixture.origin}${path}`, {
        method: 'POST', headers: authorization, body: JSON.stringify(body),
      });

      const started = await post('/inspector/start', {});
      const events = await fetch(`${fixture.origin}/inspector/events?captureId=cap-1&after=4`, { headers: authorization });
      const gone = await fetch(`${fixture.origin}/inspector/events?captureId=old&after=0`, { headers: authorization });
      const evaluated = await post('/inspector/evaluate', { captureId: 'cap-1', expression: '1 + 1' });
      const invalid = await post('/inspector/evaluate', { captureId: 'cap-1' });

      expect(await started.json()).toEqual({ captureId: 'cap-1' });
      expect(events.status).toBe(200);
      expect(gone.status).toBe(410);
      expect((await gone.json()).code).toBe('CAPTURE_GONE');
      expect(await evaluated.json()).toEqual({ text: '2', isError: false, truncated: false });
      expect(invalid.status).toBe(400);
      expect(fixture.runtime.calls.map((call) => call[0])).toEqual(['inspector-start', 'inspector-events', 'inspector-events', 'inspector-evaluate']);
    } finally {
      await fixture.service.close();
    }
  });

  test('hands the host\'s viewer headers to dock commands, input, and control notices', async () => {
    // Given a runtime that records what each request says about its viewer.
    const runtime = createRuntime();
    const seen = [];
    runtime.state = (access, options) => {
      seen.push(['state', access]);
      if (options?.problems) seen.push(['problems']);
      return { controller: 'user', selectedScopeId: null, generation: 1, scopes: [] };
    };
    runtime.navigate = async (url, generation, access) => { seen.push(['navigate', access]); };
    runtime.surfaceInput = async (events, access) => {
      seen.push(['input', access]);
      if (access.frameSeq === 3) throw new Error('The browser view changed before this input arrived');
    };
    runtime.surfaceControl = async (controller, viewer) => { seen.push(['control', controller, viewer]); };
    const fixture = await startFixture(runtime);
    try {
      const fromViewer = (headers) => ({ ...authorization, 'x-surface-viewer': 'viewer-a', ...headers });
      const input = (frameSeq) => fetch(`${fixture.origin}/surface/input`, {
        method: 'POST', headers: fromViewer({ 'x-surface-frame-seq': frameSeq }), body: JSON.stringify({ events: [{ type: 'text', text: 'a' }] }),
      });

      // When the dock of the viewer in control navigates, another viewer's dock reads state, and a window without a viewer does too with its console open.
      await fetch(`${fixture.origin}/browser/navigate`, {
        method: 'POST',
        headers: fromViewer({ 'x-surface-viewer-controls': '1', 'x-surface-frame-seq': '7' }),
        body: JSON.stringify({ url: 'example.test', generation: 1 }),
      });
      await fetch(`${fixture.origin}/browser/state`, { headers: fromViewer({ 'x-surface-viewer-controls': '0', 'x-surface-frame-seq': '7' }) });
      await fetch(`${fixture.origin}/browser/state`, { headers: authorization });
      await fetch(`${fixture.origin}/browser/state?problems=1`, { headers: authorization });

      // When input arrives on a current frame and on a stale one, and control changes hands.
      const current = await input('7');
      const stale = await input('3');
      await fetch(`${fixture.origin}/surface/control`, { method: 'POST', headers: authorization, body: JSON.stringify({ controller: 'user', viewer: 'viewer-a' }) });

      // Then only a viewer the host says is in control acts for it, and stale input answers 409.
      expect(seen).toEqual([
        ['navigate', { viewer: 'viewer-a', frameSeq: 7 }],
        ['state', { viewer: 'viewer-a', frameSeq: 7 }],
        ['state', { viewer: null, frameSeq: 7 }],
        ['state', { viewer: null, frameSeq: null }],
        ['state', { viewer: null, frameSeq: null }],
        ['problems'],
        ['input', { viewer: 'viewer-a', frameSeq: 7 }],
        ['input', { viewer: 'viewer-a', frameSeq: 3 }],
        ['control', 'user', 'viewer-a'],
      ]);
      expect(current.status).toBe(204);
      expect(stale.status).toBe(409);
    } finally {
      await fixture.service.close();
    }
  });

  test('reads browser.requestHelp itself and hands it to the manager with the chat context', async () => {
    const runtime = createRuntime();
    runtime.requestHelp = async (parameters, signal, scope) => {
      runtime.calls.push(['help', parameters, scope, signal instanceof AbortSignal]);
      return { outcome: 'handed-back', tabId: 't1', url: 'https://login.test/', title: 'Login', waitedSeconds: 12 };
    };
    const fixture = await startFixture(runtime);
    try {
      const post = (parameters) => fetch(`${fixture.origin}/browser-control`, {
        method: 'POST', headers: authorization,
        body: JSON.stringify({ requestId: 'help-1', action: 'browser.requestHelp', parameters, context: { directory: '/repo', sessionId: 'ses_1' } }),
      });

      // When the host sends a valid request, then the manager gets it with the default time limit.
      const answered = await post({ reason: '  Enter the code sent to your phone ', tabId: 't1' });
      expect(await answered.json()).toEqual({ ok: true, data: { outcome: 'handed-back', tabId: 't1', url: 'https://login.test/', title: 'Login', waitedSeconds: 12 } });
      expect(runtime.calls[0]).toEqual(['help', { reason: 'Enter the code sent to your phone', timeoutSeconds: 300, kind: 'page', tabId: 't1' }, { directory: '/repo', sessionId: 'ses_1' }, true]);

      // When the reason or time limit is out of bounds, then it is refused before reaching the manager.
      for (const parameters of [{ reason: '' }, { reason: 'x'.repeat(301) }, { reason: 'ok', timeoutSeconds: 10 }, { reason: 'ok', timeoutSeconds: 901 }, { reason: 'ok', timeoutSeconds: 60.5 }, { reason: 'ok', kind: 'otp' }, { reason: 'ok', kind: 'page', profileName: 'Acme' }, { reason: 'ok', kind: 'profile', profileName: 'x'.repeat(81) }]) {
        expect((await post(parameters)).status).toBe(400);
      }
      expect(runtime.calls.length).toBe(1);

      // When the agent asks to keep its logins in a named profile, then the name reaches the manager.
      await post({ reason: 'Keep the login', kind: 'profile', profileName: ' Acme ' });
      expect(runtime.calls[1][1]).toEqual({ reason: 'Keep the login', timeoutSeconds: 300, kind: 'profile', profileName: 'Acme' });
    } finally {
      await fixture.service.close();
    }
  });

  test('manages profiles through validated routes and wipes them only with confirmation', async () => {
    const runtime = createRuntime();
    const profiles = [];
    Object.assign(runtime, {
      async listProfiles() { return profiles; },
      async createProfile(name) { runtime.calls.push(['create', name]); profiles.push({ id: 'p1', name }); },
      async renameProfile(id, name) { runtime.calls.push(['rename', id, name]); },
      async bindProfile(id, directory) { runtime.calls.push(['bind', id, directory]); },
      async unbindProfile(id, directory) { runtime.calls.push(['unbind', id, directory]); },
      async deleteProfile(id) { runtime.calls.push(['delete', id]); },
      async closeProfile(id) { runtime.calls.push(['close-profile', id]); },
      async openProfile(id, generation) { runtime.calls.push(['open', id, generation]); },
      async revokeAllProfiles() { runtime.calls.push(['revoke-all']); },
    });
    const fixture = await startFixture(runtime);
    try {
      const post = (operation, body) => fetch(`${fixture.origin}/profiles/${operation}`, { method: 'POST', headers: authorization, body: JSON.stringify(body) });

      const created = await post('create', { name: 'Work' });
      expect((await created.json()).profiles).toEqual([{ id: 'p1', name: 'Work' }]);
      await post('rename', { id: 'p1', name: 'Job' });
      await post('bind', { id: 'p1', directory: '/repo' });
      await post('unbind', { id: 'p1', directory: '/repo' });
      await post('open', { id: 'p1', generation: 3 });
      await post('close', { id: 'p1' });
      await post('delete', { id: 'p1' });
      expect((await post('open', { id: 'p1' })).status).toBe(400);
      expect((await post('rename', { name: 'No id' })).status).toBe(400);
      expect((await post('revoke-all', {})).status).toBe(400);
      expect((await post('revoke-all', { confirm: 'REVOKE' })).status).toBe(200);
      expect((await fetch(`${fixture.origin}/profiles`, { headers: authorization })).status).toBe(200);

      expect(runtime.calls).toEqual([
        ['create', 'Work'], ['rename', 'p1', 'Job'], ['bind', 'p1', '/repo'], ['unbind', 'p1', '/repo'],
        ['open', 'p1', 3], ['close-profile', 'p1'], ['delete', 'p1'], ['revoke-all'],
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('closes a scope without saving and validates its body', async () => {
    const runtime = createRuntime();
    runtime.closeScope = async (id, generation) => { runtime.calls.push(['close-scope', id, generation]); };
    const fixture = await startFixture(runtime);
    try {
      const missing = await fetch(`${fixture.origin}/browser/close-scope`, { method: 'POST', headers: authorization, body: '{}' });
      expect(missing.status).toBe(400);
      const closed = await fetch(`${fixture.origin}/browser/close-scope`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ scopeId: '["/repo","ses_1"]', generation: 1 }),
      });
      expect(closed.status).toBe(200);
      expect(runtime.calls).toEqual([['close-scope', '["/repo","ses_1"]', 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('page/evaluate runs in the page and is refused while the agent acts', async () => {
    const runtime = createRuntime();
    runtime.pageEvaluate = async (expression, generation, access, options) => {
      runtime.calls.push(['evaluate', expression, generation, options]);
      if (expression === 'willFail') throw new Error('The agent is using this page right now');
      return expression === '1+1' ? 2 : null;
    };
    const fixture = await startFixture(runtime);
    try {
      const missing = await fetch(`${fixture.origin}/page/evaluate`, { method: 'POST', headers: authorization, body: '{}' });
      expect(missing.status).toBe(400);
      const ok = await fetch(`${fixture.origin}/page/evaluate`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1, expression: '1+1', userGesture: true }),
      });
      expect(await ok.json()).toEqual({ ok: true, value: 2 });
      const busy = await fetch(`${fixture.origin}/page/evaluate`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1, expression: 'willFail' }),
      });
      expect(busy.status).toBe(409);
      expect(runtime.calls).toEqual([
        ['evaluate', '1+1', 1, { userGesture: true }],
        ['evaluate', 'willFail', 1, { userGesture: false }],
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('page/capture answers an image and is refused while the agent acts', async () => {
    const runtime = createRuntime();
    runtime.pageCapture = async (generation) => {
      runtime.calls.push(['capture', generation]);
      return { base64: 'AA==', mime: 'image/png', width: 10, height: 20 };
    };
    const fixture = await startFixture(runtime);
    try {
      const missing = await fetch(`${fixture.origin}/page/capture`, { method: 'POST', headers: authorization, body: '{}' });
      expect(missing.status).toBe(400);
      const captured = await fetch(`${fixture.origin}/page/capture`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1 }),
      });
      expect(await captured.json()).toEqual({ ok: true, base64: 'AA==', mime: 'image/png', width: 10, height: 20 });
      expect(runtime.calls).toEqual([['capture', 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('page/zoom validates its level and reaches the manager', async () => {
    const runtime = createRuntime();
    runtime.pageZoom = async (level, generation) => { runtime.calls.push(['zoom', level, generation]); };
    const fixture = await startFixture(runtime);
    try {
      const invalid = await fetch(`${fixture.origin}/page/zoom`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1, level: 6 }),
      });
      expect(invalid.status).toBe(400);
      const valid = await fetch(`${fixture.origin}/page/zoom`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1, level: -2 }),
      });
      expect(valid.status).toBe(200);
      expect(runtime.calls).toEqual([['zoom', -2, 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('page/clear validates "what" and reaches the manager', async () => {
    const runtime = createRuntime();
    runtime.pageClear = async (what, generation) => { runtime.calls.push(['clear', what, generation]); };
    const fixture = await startFixture(runtime);
    try {
      const invalid = await fetch(`${fixture.origin}/page/clear`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1, what: 'everything' }),
      });
      expect(invalid.status).toBe(400);
      const cleared = await fetch(`${fixture.origin}/page/clear`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ generation: 1, what: 'cache' }),
      });
      expect(cleared.status).toBe(200);
      expect(runtime.calls).toEqual([['clear', 'cache', 1]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('page/dialog and page/file-chooser validate their answers and pass the viewer\'s access', async () => {
    // Given a runtime that records the answers it gets.
    const runtime = createRuntime();
    runtime.pageDialog = async (answer, access) => { runtime.calls.push(['dialog', answer, access]); };
    runtime.pageFileChooser = async (answer, access) => {
      runtime.calls.push(['chooser', answer, access]);
      if (answer.files?.includes('gone.txt')) throw new Error('That file request is no longer open');
    };
    const fixture = await startFixture(runtime);
    try {
      const post = (route, body, headers = {}) => fetch(`${fixture.origin}${route}`, {
        method: 'POST', headers: { ...authorization, ...headers }, body: JSON.stringify(body),
      });

      // When answers miss their ids, carry a non-boolean accept, or list no file names, then they are refused unread.
      const refused = await Promise.all([
        post('/page/dialog', { tabId: 't1', accept: true }),
        post('/page/dialog', { tabId: 't1', dialogId: 2, accept: 'yes' }),
        post('/page/dialog', { tabId: 't1', dialogId: 2, accept: true, promptText: 7 }),
        post('/page/file-chooser', { tabId: 't1', chooserId: 3, files: [] }),
        post('/page/file-chooser', { tabId: 't1', chooserId: 3, files: [''] }),
        post('/page/file-chooser', { chooserId: 3, cancel: true }),
      ]);
      expect(refused.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);

      // When the viewer in control answers a prompt, picks files, and cancels a request.
      const viewer = { 'x-surface-viewer': 'viewer-a', 'x-surface-viewer-controls': '1' };
      const dialog = await post('/page/dialog', { tabId: 't1', dialogId: 2, accept: true, promptText: 'Grace' }, viewer);
      const chosen = await post('/page/file-chooser', { tabId: 't1', chooserId: 3, files: ['a.txt', 'b.txt'] }, viewer);
      const cancelled = await post('/page/file-chooser', { tabId: 't1', chooserId: 4, cancel: true });
      const gone = await post('/page/file-chooser', { tabId: 't1', chooserId: 5, files: ['gone.txt'] });

      // Then each reaches the manager with that viewer, and a request that is gone answers 404.
      expect([dialog.status, chosen.status, cancelled.status, gone.status]).toEqual([200, 200, 200, 404]);
      expect(runtime.calls).toEqual([
        ['dialog', { tabId: 't1', dialogId: 2, accept: true, promptText: 'Grace' }, { viewer: 'viewer-a', frameSeq: null }],
        ['chooser', { tabId: 't1', chooserId: 3, files: ['a.txt', 'b.txt'] }, { viewer: 'viewer-a', frameSeq: null }],
        ['chooser', { tabId: 't1', chooserId: 4, files: null }, { viewer: null, frameSeq: null }],
        ['chooser', { tabId: 't1', chooserId: 5, files: ['gone.txt'] }, { viewer: null, frameSeq: null }],
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('help/profile passes the person\'s answer with their access and refuses anything but true or false', async () => {
    const runtime = createRuntime();
    runtime.answerProfileRequest = (approve, access) => {
      runtime.calls.push(['profile-answer', approve, access]);
      if (!approve) throw new Error('No profile request is waiting for an answer');
    };
    const fixture = await startFixture(runtime);
    try {
      const post = (body, headers = {}) => fetch(`${fixture.origin}/help/profile`, {
        method: 'POST', headers: { ...authorization, ...headers }, body: JSON.stringify(body),
      });
      expect((await post({ approve: 'yes' })).status).toBe(400);
      const viewer = { 'x-surface-viewer': 'viewer-a', 'x-surface-viewer-controls': '1' };
      expect((await post({ approve: true }, viewer)).status).toBe(200);
      expect((await post({ approve: false })).status).toBe(400);
      expect(runtime.calls).toEqual([
        ['profile-answer', true, { viewer: 'viewer-a', frameSeq: null }],
        ['profile-answer', false, { viewer: null, frameSeq: null }],
      ]);
    } finally {
      await fixture.service.close();
    }
  });

  test('GET /surface/audio answers length-prefixed Opus with its format, or no content', async () => {
    // Given a runtime with one batch of sound and then none.
    const runtime = createRuntime();
    const packets = Buffer.from([0, 2, 7, 8, 0, 1, 9]);
    let pending = { seq: 12, codec: 'opus', sampleRate: 48_000, channels: 2, bytes: packets };
    runtime.surfaceAudio = async (request) => {
      runtime.calls.push(['audio', request.after, request.wait]);
      const batch = pending;
      pending = null;
      return batch;
    };
    const fixture = await startFixture(runtime);
    try {
      // When the host asks for sound, then it gets the packets and their format.
      const first = await fetch(`${fixture.origin}/surface/audio?after=0&wait=25000`, { headers: authorization });
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('application/octet-stream');
      expect(first.headers.get('x-surface-seq')).toBe('12');
      expect(first.headers.get('x-surface-audio-codec')).toBe('opus');
      expect(first.headers.get('x-surface-audio-sample-rate')).toBe('48000');
      expect(first.headers.get('x-surface-audio-channels')).toBe('2');
      expect(Buffer.from(await first.arrayBuffer())).toEqual(packets);

      // When nothing new arrived, then the answer is empty; a wait past the limit is refused.
      const none = await fetch(`${fixture.origin}/surface/audio?after=12&wait=0`, { headers: authorization });
      expect(none.status).toBe(204);
      const tooLong = await fetch(`${fixture.origin}/surface/audio?after=12&wait=999999`, { headers: authorization });
      expect(tooLong.status).toBe(400);
      expect(runtime.calls).toEqual([['audio', 0, 25000], ['audio', 12, 0]]);
    } finally {
      await fixture.service.close();
    }
  });

  test('GET /chrome answers the chrome status function, or 404 without one', async () => {
    const fixture = await startFixture();
    try {
      expect((await fetch(`${fixture.origin}/chrome`, { headers: authorization })).status).toBe(404);
    } finally {
      await fixture.service.close();
    }

    const withChrome = createService({
      runtime: createRuntime(),
      token: TOKEN,
      port: 0,
      chromeStatus: () => ({ status: 'ready', message: '', path: '/usr/bin/google-chrome', version: '120.0.0.0' }),
    });
    const address = await withChrome.listen();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/chrome`, { headers: authorization });
      expect(await response.json()).toEqual({ status: 'ready', message: '', path: '/usr/bin/google-chrome', version: '120.0.0.0' });
    } finally {
      await withChrome.close();
    }
  });

  test('profiles/sites lists and clears a site through the profileSites port', async () => {
    const listed = [];
    const cleared = [];
    const profileSites = {
      list: async (id) => { listed.push(id); return [{ domain: 'example.test', cookies: 2 }]; },
      clear: async (id, domain) => { cleared.push([id, domain]); return { sites: [], version: 2 }; },
    };
    const service = createService({ runtime: createRuntime(), token: TOKEN, port: 0, profileSites });
    const address = await service.listen();
    const origin = `http://${address.host}:${address.port}`;
    try {
      const missingId = await fetch(`${origin}/profiles/sites`, { headers: authorization });
      expect(missingId.status).toBe(400);
      const listing = await fetch(`${origin}/profiles/sites?id=p1`, { headers: authorization });
      expect(await listing.json()).toEqual({ ok: true, sites: [{ domain: 'example.test', cookies: 2 }] });
      expect(listed).toEqual(['p1']);

      const missingDomain = await fetch(`${origin}/profiles/sites/clear`, { method: 'POST', headers: authorization, body: JSON.stringify({ id: 'p1' }) });
      expect(missingDomain.status).toBe(400);
      const clearedResponse = await fetch(`${origin}/profiles/sites/clear`, {
        method: 'POST', headers: authorization, body: JSON.stringify({ id: 'p1', domain: 'example.test' }),
      });
      expect(await clearedResponse.json()).toEqual({ ok: true, sites: [] });
      expect(cleared).toEqual([['p1', 'example.test']]);
    } finally {
      await service.close();
    }
  });

  test('reads browser.saveProfile itself and hands it to the manager', async () => {
    const runtime = createRuntime();
    runtime.saveProfile = async (parameters, signal, scope) => {
      runtime.calls.push(['save', parameters, scope]);
      return { saved: true, profile: 'Work', version: 3, reopenedTabs: 1 };
    };
    const fixture = await startFixture(runtime);
    try {
      const answered = await fetch(`${fixture.origin}/browser-control`, {
        method: 'POST', headers: authorization,
        body: JSON.stringify({ requestId: 'save-1', action: 'browser.saveProfile', parameters: {}, context: { directory: '/repo', sessionId: 'ses_1' } }),
      });
      expect(await answered.json()).toEqual({ ok: true, data: { saved: true, profile: 'Work', version: 3, reopenedTabs: 1 } });
      expect(runtime.calls).toEqual([['save', {}, { directory: '/repo', sessionId: 'ses_1' }]]);
    } finally {
      await fixture.service.close();
    }
  });
});
