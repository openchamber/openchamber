import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RUNTIME_CONFIG_SCRIPT, RUNTIME_CONFIG_SCRIPT_PATHNAME, createRuntimeConfigGate, injectRuntimeConfig, isRuntimeConfigFrame } from './packaged-runtime-config.mjs';

const HTML = '<html><head><script type="module" src="/assets/main.js"></script></head><body><div id="initial-loading"></div><script>late()</script></body></html>';

describe('packaged runtime config injection', () => {
  it('asks for the values before every other head script', () => {
    const html = injectRuntimeConfig(HTML, { pending: false });
    assert.ok(html.startsWith(`<html><head><script>${RUNTIME_CONFIG_SCRIPT}</script><script type="module"`));
    assert.ok(!html.includes(RUNTIME_CONFIG_SCRIPT_PATHNAME));
  });

  it('ends a pending document with the blocking script, after its loading screen and own scripts', () => {
    const html = injectRuntimeConfig(HTML, { pending: true });
    const tag = `<script src="${RUNTIME_CONFIG_SCRIPT_PATHNAME}"></script>`;
    assert.ok(html.endsWith(`<script>late()</script>${tag}</body></html>`));
    assert.ok(html.indexOf('initial-loading') < html.indexOf(tag));
    // A classic script without async/defer, so parsing (and therefore module execution) waits for it.
    assert.ok(!/async|defer|type=/.test(tag));
  });

  it('appends the blocking script to a document without a body end tag', () => {
    const html = injectRuntimeConfig('<p>x</p>', { pending: true });
    assert.equal(html, `<p>x</p><script src="${RUNTIME_CONFIG_SCRIPT_PATHNAME}"></script>`);
  });
});

describe('runtime config script', () => {
  const VALUES = {
    localOrigin: 'http://127.0.0.1:1',
    apiBaseUrl: 'http://127.0.0.1:2',
    clientToken: 'value',
    requestHeaders: { 'X-Hosting-Token': 'header-value' },
  };
  const run = (globals) => {
    const window = { ...globals };
    vm.runInNewContext(RUNTIME_CONFIG_SCRIPT, { window });
    return window;
  };

  it('sets what the bridge returns', () => {
    const window = run({ __OPENCHAMBER_READ_RUNTIME_CONFIG__: () => VALUES });
    assert.equal(window.__OPENCHAMBER_LOCAL_ORIGIN__, VALUES.localOrigin);
    assert.equal(window.__OPENCHAMBER_API_BASE_URL__, VALUES.apiBaseUrl);
    assert.equal(window.__OPENCHAMBER_CLIENT_TOKEN__, VALUES.clientToken);
    assert.deepEqual(window.__OPENCHAMBER_RUNTIME_HEADERS__, VALUES.requestHeaders);
  });

  it('keeps the values the preload exposed for this window', () => {
    const window = run({
      __OPENCHAMBER_READ_RUNTIME_CONFIG__: () => VALUES,
      __OPENCHAMBER_API_BASE_URL__: 'http://other-host',
      __OPENCHAMBER_CLIENT_TOKEN__: 'other-value',
      __OPENCHAMBER_RUNTIME_HEADERS__: { 'X-Other': 'other-value' },
    });
    assert.equal(window.__OPENCHAMBER_API_BASE_URL__, 'http://other-host');
    assert.equal(window.__OPENCHAMBER_CLIENT_TOKEN__, 'other-value');
    assert.deepEqual(window.__OPENCHAMBER_RUNTIME_HEADERS__, { 'X-Other': 'other-value' });
  });

  it('leaves the token and headers unset when there are none', () => {
    const window = run({ __OPENCHAMBER_READ_RUNTIME_CONFIG__: () => ({ ...VALUES, clientToken: '', requestHeaders: {} }) });
    assert.equal(window.__OPENCHAMBER_CLIENT_TOKEN__, undefined);
    assert.equal(window.__OPENCHAMBER_RUNTIME_HEADERS__, undefined);
  });

  it('sets nothing in a frame without the bridge, or when main refuses', () => {
    assert.deepEqual(run({}), {});
    assert.equal(run({ __OPENCHAMBER_READ_RUNTIME_CONFIG__: () => null }).__OPENCHAMBER_API_BASE_URL__, undefined);
  });
});

describe('runtime config frame check', () => {
  it('accepts only the top frame of the packaged application', () => {
    assert.equal(isRuntimeConfigFrame({ parent: null, origin: 'openchamber-ui://app' }), true);
    assert.equal(isRuntimeConfigFrame({ parent: {}, origin: 'openchamber-ui://app' }), false);
    assert.equal(isRuntimeConfigFrame({ parent: {}, origin: 'null' }), false);
    assert.equal(isRuntimeConfigFrame({ parent: null, origin: 'http://127.0.0.1:3000' }), false);
    assert.equal(isRuntimeConfigFrame({ parent: null, origin: 'null' }), false);
    assert.equal(isRuntimeConfigFrame(null), false);
  });

  it('refuses a frame that is already gone', () => {
    const gone = { get parent() { throw new Error('Render frame was disposed'); } };
    assert.equal(isRuntimeConfigFrame(gone), false);
  });
});

describe('runtime config gate', () => {
  it('is open until held', async () => {
    const gate = createRuntimeConfigGate();
    assert.equal(gate.isHeld(), false);
    await gate.whenReleased();
  });

  it('holds waiters until released, then opens for later requests', async () => {
    const gate = createRuntimeConfigGate();
    gate.hold();
    gate.hold();
    assert.equal(gate.isHeld(), true);
    let released = false;
    const waiter = gate.whenReleased().then(() => { released = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, false);
    gate.release();
    await waiter;
    assert.equal(released, true);
    assert.equal(gate.isHeld(), false);
    await gate.whenReleased();
  });

  it('tolerates a release without a hold', () => {
    const gate = createRuntimeConfigGate();
    gate.release();
    assert.equal(gate.isHeld(), false);
  });
});
