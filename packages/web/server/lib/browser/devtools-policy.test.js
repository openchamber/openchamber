import { describe, expect, it } from 'vitest';

import { createDevToolsPolicy } from './devtools-policy.js';

const command = (method, params = {}, extra = {}) => JSON.stringify({ id: 1, method, params, ...extra });

describe('DevTools CDP policy', () => {
  it('allows page inspection and editing commands while identifying viewport changes', () => {
    const policy = createDevToolsPolicy({ browserContextId: 'context-a', targetId: 'page-a' });
    expect(policy.command(command('DOM.getDocument')).ok).toBe(true);
    expect(policy.command(command('CSS.setStyleTexts', { edits: [] })).ok).toBe(true);
    expect(policy.command(command('Debugger.setBreakpointByUrl', { lineNumber: 1, url: 'https://example.test/app.js' })).ok).toBe(true);
    expect(policy.command(command('Network.enable')).ok).toBe(true);
    expect(policy.command(command('Target.autoAttachRelated', {
      targetId: 'page-a', waitForDebuggerOnStart: true,
    })).ok).toBe(true);
    expect(policy.command(command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })))
      .toMatchObject({ ok: true, viewportChanged: true });
  });

  it('rejects browser-global, native, download, and unsafe navigation commands', () => {
    const policy = createDevToolsPolicy({ browserContextId: 'context-a', targetId: 'page-a' });
    for (const raw of [
      command('Browser.close'),
      command('Browser.getBrowserCommandLine'),
      command('Target.getTargets'),
      command('Target.createBrowserContext'),
      command('SystemInfo.getInfo'),
      command('Tethering.bind', { port: 9222 }),
      command('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/private' }),
      command('Page.navigate', { url: 'file:///etc/passwd' }),
    ]) {
      expect(policy.command(raw).ok).toBe(false);
    }
    expect(policy.command(command('Page.navigate', { url: 'file:///etc/passwd' })))
      .toMatchObject({ ok: false, code: 'DEVTOOLS_PROTOCOL_REJECTED' });
    expect(policy.command(command('Page.navigate', { url: 'https://example.test/path' })).ok).toBe(true);
    expect(policy.command(command('Browser.getVersion')).ok).toBe(true);
    expect(policy.command(command('Target.setDiscoverTargets', { discover: true }))).toMatchObject({
      ok: false, response: { id: 1, error: { code: -32_000, message: 'Command is not available for this page' } },
    });
    for (const method of ['Page.startScreencast', 'Page.screencastFrameAck', 'Page.stopScreencast']) {
      expect(policy.command(command(method))).toMatchObject({
        ok: false, response: { id: 1, error: { code: -32_000, message: 'Command is not available for this page' } },
      });
    }
  });

  it('keeps explicit browser contexts and child sessions inside the owned context', () => {
    const policy = createDevToolsPolicy({ browserContextId: 'context-a', targetId: 'page-a' });
    expect(policy.command(command('Storage.clearDataForOrigin', { origin: 'https://example.test', browserContextId: 'context-b' })).ok).toBe(false);
    expect(policy.command(command('Storage.getCookies'))).toMatchObject({
      ok: true, message: { params: { browserContextId: 'context-a' } },
    });
    expect(policy.command(command('Storage.clearCookies', { browserContextId: 'context-b' })).ok).toBe(false);
    expect(policy.event(JSON.stringify({ method: 'Target.attachedToTarget', params: {
      sessionId: 'child-a', targetInfo: { targetId: 'worker-a', type: 'worker', browserContextId: 'context-a' },
    } }))).toMatchObject({ ok: true });
    expect(policy.command(command('Runtime.enable', {}, { sessionId: 'child-a' })).ok).toBe(true);
    expect(policy.command(command('Runtime.enable', {}, { sessionId: 'foreign' })).ok).toBe(false);
    expect(policy.event(JSON.stringify({ method: 'Runtime.consoleAPICalled', sessionId: 'foreign', params: {} })).ok).toBe(false);
  });

  it('marks tracing lifecycle and limits IO to handles issued by the owned trace', () => {
    const policy = createDevToolsPolicy({ browserContextId: 'context-a', targetId: 'page-a' });
    expect(policy.command(command('Tracing.start', { transferMode: 'ReturnAsStream' }))).toMatchObject({ ok: true, trace: 'start' });
    expect(policy.event(JSON.stringify({ method: 'Tracing.tracingComplete', params: { stream: 'trace-handle' } }))).toMatchObject({ ok: true, trace: 'complete' });
    expect(policy.command(command('IO.read', { handle: 'trace-handle' })).ok).toBe(true);
    expect(policy.command(command('IO.read', { handle: 'foreign-handle' })).ok).toBe(false);
    expect(policy.command(command('IO.close', { handle: 'trace-handle' }))).toMatchObject({ ok: true, closedHandle: 'trace-handle' });
  });

  it('limits IO to successful network resource streams from the matching request session', () => {
    const policy = createDevToolsPolicy({ browserContextId: 'context-a', targetId: 'page-a' });
    for (const sessionId of ['child-a', 'child-b']) {
      expect(policy.event(JSON.stringify({ method: 'Target.attachedToTarget', params: {
        sessionId, targetInfo: { targetId: `worker-${sessionId}`, type: 'worker', browserContextId: 'context-a' },
      } }))).toMatchObject({ ok: true });
    }

    expect(policy.command(command('Network.loadNetworkResource', {
      frameId: 'frame-a', url: 'http://localhost:3000/app.js', options: {},
    }, { id: 10, sessionId: 'child-a' }))).toMatchObject({ ok: true });
    expect(policy.command(command('IO.read', { handle: 'network-stream' })).ok).toBe(false);

    expect(policy.event(JSON.stringify({ id: 10, sessionId: 'child-b', result: { resource: {
      success: true, httpStatusCode: 200, stream: 'wrong-session-stream', headers: {},
    } } }))).toMatchObject({ ok: true });
    expect(policy.command(command('IO.read', { handle: 'wrong-session-stream' })).ok).toBe(false);

    expect(policy.event(JSON.stringify({ id: 10, sessionId: 'child-a', result: { resource: {
      success: true, httpStatusCode: 200, stream: 'network-stream', headers: {},
    } } }))).toMatchObject({ ok: true });
    expect(policy.command(command('IO.read', { handle: 'network-stream', size: 1_048_576 })).ok).toBe(true);

    expect(policy.event(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'child-a' } })))
      .toMatchObject({ ok: true });
    expect(policy.command(command('IO.read', { handle: 'network-stream' })).ok).toBe(false);

    expect(policy.command(command('Network.loadNetworkResource', {
      frameId: 'frame-a', url: 'http://localhost:3000/missing.js', options: {},
    }, { id: 11 }))).toMatchObject({ ok: true });
    expect(policy.event(JSON.stringify({ id: 11, result: { resource: {
      success: false, httpStatusCode: 404, stream: 'failed-stream', headers: {},
    } } }))).toMatchObject({ ok: true });
    expect(policy.event(JSON.stringify({ id: 11, result: { resource: {
      success: true, httpStatusCode: 200, stream: 'late-stream', headers: {},
    } } }))).toMatchObject({ ok: true });
    expect(policy.command(command('IO.read', { handle: 'failed-stream' })).ok).toBe(false);
    expect(policy.command(command('IO.read', { handle: 'late-stream' })).ok).toBe(false);
  });

  it('bounds unanswered network stream requests and frees capacity when a response arrives', () => {
    const policy = createDevToolsPolicy({ browserContextId: 'context-a', targetId: 'page-a' });
    for (let id = 1; id <= 1_024; id += 1) {
      expect(policy.command(command('Network.loadNetworkResource', {
        frameId: 'frame-a', url: `https://example.test/${id}.js`, options: {},
      }, { id })).ok).toBe(true);
    }
    expect(policy.command(command('Network.loadNetworkResource', {
      frameId: 'frame-a', url: 'https://example.test/overflow.js', options: {},
    }, { id: 1_025 }))).toMatchObject({
      ok: false, response: { id: 1_025, error: { code: -32_000, message: 'Command is not available for this page' } },
    });

    expect(policy.event(JSON.stringify({ id: 1, error: { code: -32_001, message: 'Resource load failed' } })))
      .toMatchObject({ ok: true });
    expect(policy.command(command('Network.loadNetworkResource', {
      frameId: 'frame-a', url: 'https://example.test/after-response.js', options: {},
    }, { id: 1_025 }))).toMatchObject({ ok: true });
  });
});
