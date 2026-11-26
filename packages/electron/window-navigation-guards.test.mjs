import assert from 'node:assert/strict';
import test from 'node:test';
import { attachWindowNavigationGuards } from './window-navigation-guards.mjs';

// Desktop HMR: the window document is on the UI dev origin (5173), the local API on 3901.
const MAIN_ALLOWED_ORIGINS = ['http://127.0.0.1:5173', 'http://127.0.0.1:3901'];
const MINI_CHAT_ALLOWED_ORIGINS = ['http://127.0.0.1:3901'];

const createHarness = ({
  routeLinks = true,
  currentUrl = 'http://127.0.0.1:5173/',
  allowedOrigins = routeLinks ? MAIN_ALLOWED_ORIGINS : MINI_CHAT_ALLOWED_ORIGINS,
} = {}) => {
  const listeners = new Map();
  let windowOpenHandler = null;
  const externalOpened = [];
  const hostOpened = [];
  const sessionOpened = [];
  const warnings = [];
  const mainFrame = { url: currentUrl };

  const webContents = {
    mainFrame,
    getURL: () => currentUrl,
    setWindowOpenHandler: (handler) => {
      windowOpenHandler = handler;
    },
    on: (event, handler) => {
      listeners.set(event, handler);
    },
  };

  const remoteHost = { id: 'host-remote', url: 'https://remote.example.test' };

  attachWindowNavigationGuards({
    webContents,
    uiProtocol: 'openchamber-ui',
    getAllowedOrigins: () => allowedOrigins,
    findConfiguredHostForUrl: (raw) => {
      try {
        return new URL(raw).origin === 'https://remote.example.test' ? remoteHost : null;
      } catch {
        return null;
      }
    },
    sessionRouteFromUrl: (raw) => {
      try {
        const session = new URL(raw).searchParams.get('session');
        return session ? { sessionId: session } : null;
      } catch {
        return null;
      }
    },
    openHostWindow: async (host, route, opts) => {
      hostOpened.push({ host, route, opts });
    },
    onOpenSession: (route) => {
      sessionOpened.push(route);
    },
    openExternal: async (url) => {
      externalOpened.push(url);
    },
    log: { warn: (...args) => warnings.push(args.join(' ')) },
    routeLinks,
  });

  const triggerWillNavigate = (url) => {
    let prevented = false;
    listeners.get('will-navigate')({ preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };

  const triggerWillFrameNavigate = (details) => {
    let prevented = false;
    listeners.get('will-frame-navigate')({ ...details, preventDefault: () => { prevented = true; } });
    return prevented;
  };

  return {
    mainFrame,
    externalOpened,
    hostOpened,
    sessionOpened,
    warnings,
    triggerWindowOpen: (url) => windowOpenHandler({ url }),
    triggerWillNavigate,
    triggerWillFrameNavigate,
  };
};

const BLOCKED_AUTO_OPEN_URLS = [
  'ms-msdt:/id%20PCWDiagnostic',
  'search-ms:query=report',
  'file:///etc/passwd',
  'smb://files.example.test/share',
  'ssh://user@example.test',
  'ms-officecmd:ofe|u|https://example.test/doc.docx',
  'javascript:alert(1)',
  'mailto:user@example.test',
  'vscode://file/Users/person/Project/package.json:7',
  'evil-test://payload',
];

for (const [label, routeLinks] of [['main window', true], ['mini chat window', false]]) {
  test(`${label} opens only http and https on automatic popup and navigation fallbacks`, () => {
    const harness = createHarness({ routeLinks });

    for (const url of BLOCKED_AUTO_OPEN_URLS) {
      assert.deepEqual(harness.triggerWindowOpen(url), { action: 'deny' }, `popup ${url}`);
      assert.equal(harness.triggerWillNavigate(url), true, `navigate ${url}`);
    }
    assert.deepEqual(harness.externalOpened, []);

    assert.deepEqual(harness.triggerWindowOpen(' HTTPS://DOCS.EXAMPLE.TEST/guide '), { action: 'deny' });
    assert.equal(harness.triggerWillNavigate('http://external.example.test/page'), true);
    assert.equal(harness.triggerWillNavigate('https://external.example.test/bad\r\n'), true);
    assert.deepEqual(harness.externalOpened, [
      'https://docs.example.test/guide',
      'http://external.example.test/page',
    ]);
  });

  test(`${label} stays on local app origins and blocks untrusted opaque guest frames`, () => {
    const harness = createHarness({ routeLinks });

    assert.equal(harness.triggerWillNavigate('http://127.0.0.1:3901/index.html'), false);
    assert.equal(harness.triggerWillNavigate('openchamber-ui://app/index.html'), false);
    assert.equal(harness.triggerWillNavigate('devtools://devtools/bundled/inspector.html'), false);
    assert.deepEqual(harness.externalOpened, []);

    assert.equal(
      harness.triggerWillFrameNavigate({
        isMainFrame: false,
        frame: { origin: 'null', url: 'http://127.0.0.1:3901/api/guests/demo/index.html', parent: harness.mainFrame },
        initiator: null,
        url: 'https://evil.example.test/?leak=1',
      }),
      true,
    );
    assert.equal(
      harness.triggerWillFrameNavigate({
        isMainFrame: false,
        frame: { origin: 'null', url: '', parent: harness.mainFrame },
        initiator: harness.mainFrame,
        url: 'https://remote.example.test/api/guests/demo/index.html',
      }),
      false,
    );
  });
}

test('main window routes configured hosts to their window and local session links to itself', () => {
  const harness = createHarness({ routeLinks: true });
  assert.equal(harness.triggerWillNavigate('https://remote.example.test/?session=ses_remote'), false);
  assert.deepEqual(harness.hostOpened, []);

  assert.deepEqual(harness.triggerWindowOpen('https://remote.example.test/?session=ses_popup'), { action: 'deny' });
  assert.equal(harness.hostOpened.length, 1);
  assert.deepEqual(harness.hostOpened[0].route, { sessionId: 'ses_popup' });

  assert.deepEqual(harness.triggerWindowOpen('http://127.0.0.1:5173/?session=ses_123'), { action: 'deny' });
  assert.deepEqual(harness.triggerWindowOpen('http://127.0.0.1:3901/docs'), { action: 'deny' });
  assert.deepEqual(harness.sessionOpened, [{ sessionId: 'ses_123' }]);
  assert.deepEqual(harness.externalOpened, []);
});

test('main window keeps navigation to its own document origin', () => {
  const harness = createHarness({ routeLinks: true });
  assert.equal(harness.triggerWillNavigate('http://127.0.0.1:5173/index.html'), false);
  assert.deepEqual(harness.externalOpened, []);
});

test('mini chat sends every http(s) popup and off-origin navigation to the browser', () => {
  const harness = createHarness({ routeLinks: false });

  assert.equal(harness.triggerWillNavigate('https://remote.example.test/?session=ses_mini'), true);
  assert.equal(harness.triggerWillNavigate('http://127.0.0.1:5173/other.html'), true);
  assert.deepEqual(harness.triggerWindowOpen('https://remote.example.test/?session=ses_popup'), { action: 'deny' });
  assert.deepEqual(harness.triggerWindowOpen('http://127.0.0.1:5173/?session=ses_123'), { action: 'deny' });
  assert.deepEqual(harness.triggerWindowOpen('http://127.0.0.1:3901/docs'), { action: 'deny' });

  assert.deepEqual(harness.hostOpened, []);
  assert.deepEqual(harness.sessionOpened, []);
  assert.deepEqual(harness.externalOpened, [
    'https://remote.example.test/?session=ses_mini',
    'http://127.0.0.1:5173/other.html',
    'https://remote.example.test/?session=ses_popup',
    'http://127.0.0.1:5173/?session=ses_123',
    'http://127.0.0.1:3901/docs',
  ]);
});
