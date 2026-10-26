import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_CONFIG_SCRIPT_PATHNAME, claimRuntimeConfigScriptRequest, createRuntimeConfigGate, injectRuntimeConfig } from './packaged-runtime-config.mjs';

const HTML = '<html><head><script type="module" src="/assets/main.js"></script></head><body><div id="initial-loading"></div><script>late()</script></body></html>';

describe('packaged runtime config injection', () => {
  it('inlines resolved values before every other head script', () => {
    const html = injectRuntimeConfig(HTML, { pending: false, scriptBody: 'window.x=1;' });
    assert.ok(html.startsWith('<html><head><script>window.x=1;</script><script type="module"'));
    assert.ok(!html.includes(RUNTIME_CONFIG_SCRIPT_PATHNAME));
  });

  it('ends a pending document with the blocking script, after its loading screen and own scripts', () => {
    const html = injectRuntimeConfig(HTML, { pending: true, scriptBody: '', nonce: 'n1' });
    const tag = `<script src="${RUNTIME_CONFIG_SCRIPT_PATHNAME}?nonce=n1"></script>`;
    assert.ok(html.endsWith(`<script>late()</script>${tag}</body></html>`));
    assert.ok(html.indexOf('initial-loading') < html.indexOf(tag));
    // A classic script without async/defer, so parsing (and therefore module execution) waits for it.
    assert.ok(!/async|defer|type=/.test(tag));
  });

  it('appends the blocking script to a document without a body end tag', () => {
    const html = injectRuntimeConfig('<p>x</p>', { pending: true, scriptBody: '', nonce: 'n1' });
    assert.equal(html, `<p>x</p><script src="${RUNTIME_CONFIG_SCRIPT_PATHNAME}?nonce=n1"></script>`);
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

describe('runtime config script access', () => {
  const scriptUrl = (nonce) => `openchamber-ui://app${RUNTIME_CONFIG_SCRIPT_PATHNAME}${nonce === undefined ? '' : `?nonce=${nonce}`}`;
  const sameOriginScript = new Headers({ 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' });
  const sequentialGate = () => {
    let n = 0;
    return createRuntimeConfigGate({ createNonce: () => `nonce-${++n}` });
  };

  it('answers the document it issued the nonce to, once', () => {
    const gate = sequentialGate();
    gate.hold();
    const nonce = gate.issueScriptNonce();
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(nonce), headers: sameOriginScript }), true);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(nonce), headers: sameOriginScript }), false);
  });

  it('still answers an issued nonce after the gate is released', () => {
    const gate = sequentialGate();
    gate.hold();
    const nonce = gate.issueScriptNonce();
    gate.release();
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(nonce), headers: new Headers() }), true);
  });

  it('refuses requests without a nonce or with one it never issued', () => {
    const gate = sequentialGate();
    gate.hold();
    gate.issueScriptNonce();
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(), headers: sameOriginScript }), false);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl('guess'), headers: sameOriginScript }), false);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(''), headers: sameOriginScript }), false);
  });

  it('refuses cross-site and non-script loads without spending the nonce', () => {
    const gate = sequentialGate();
    gate.hold();
    const nonce = gate.issueScriptNonce();
    const crossSite = new Headers({ 'sec-fetch-dest': 'script', 'sec-fetch-site': 'cross-site' });
    const asFetch = new Headers({ 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' });
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(nonce), headers: crossSite }), false);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(nonce), headers: asFetch }), false);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(nonce), headers: sameOriginScript }), true);
  });

  it('gives each pending document its own nonce', () => {
    const gate = sequentialGate();
    gate.hold();
    const first = gate.issueScriptNonce();
    const second = gate.issueScriptNonce();
    assert.notEqual(first, second);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(second), headers: sameOriginScript }), true);
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: scriptUrl(first), headers: sameOriginScript }), true);
  });

  it('ignores other paths', () => {
    const gate = sequentialGate();
    const nonce = gate.issueScriptNonce();
    assert.equal(claimRuntimeConfigScriptRequest(gate, { url: `openchamber-ui://app/index.html?nonce=${nonce}`, headers: sameOriginScript }), false);
  });
});
