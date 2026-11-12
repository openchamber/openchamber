import assert from 'node:assert/strict';
import test from 'node:test';
import { installCaptureGuard } from '../src/capture-guard.js';

// A Chrome that answers every command, except the ones named in `refuse`
// (an error from Chrome) and `late` (no answer in time), and records them.
const fakeChrome = ({ refuse = [], late = [], whileInstalling = () => {} } = {}) => {
  const listeners = new Set();
  const sent = [];
  const answer = (method) => {
    if (refuse.includes(method)) return Promise.reject(Object.assign(new Error(`${method} refused`), { code: 'protocol' }));
    if (late.includes(method)) return Promise.reject(Object.assign(new Error(`${method} timed out`), { code: 'timeout' }));
    return Promise.resolve({});
  };
  const attach = (sessionId, type, waitingForDebugger) => {
    for (const listener of listeners) {
      listener({ method: 'Target.attachedToTarget', params: { sessionId, waitingForDebugger, targetInfo: { targetId: `target-${sessionId}`, type } } });
    }
  };
  const cdp = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method, params) {
      sent.push([null, method, params]);
      if (method === 'Target.setAutoAttach') whileInstalling(attach);
      return answer(method);
    },
    sendSession(sessionId, method, params) {
      sent.push([sessionId, method, params]);
      return answer(method);
    },
  };
  return { cdp, sent, attach, listeners };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const methodsFor = (sent, sessionId) => sent.filter(([session]) => session === sessionId).map(([, method]) => method);

test('guards every new page and frame before resuming it, and only resumes other targets', async () => {
  // Given the guard installed in a Chrome.
  const chrome = fakeChrome();
  await installCaptureGuard(chrome.cdp);

  // When a page, a frame, and a worker are attached paused.
  chrome.attach('page-1', 'page', true);
  chrome.attach('frame-1', 'iframe', true);
  chrome.attach('worker-1', 'worker', true);
  await settle();

  // Then pages and frames get the guard, then the resume, in that order; a worker is only resumed.
  const guarded = ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'];
  assert.deepEqual(methodsFor(chrome.sent, 'page-1'), guarded);
  assert.deepEqual(methodsFor(chrome.sent, 'frame-1'), guarded);
  assert.deepEqual(methodsFor(chrome.sent, 'worker-1'), ['Runtime.runIfWaitingForDebugger']);
  const [, , script] = chrome.sent.find(([session, method]) => session === 'page-1' && method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(script.runImmediately, true);
  assert.match(script.source, /getDisplayMedia/);
  const [, , nested] = chrome.sent.find(([session, method]) => session === 'page-1' && method === 'Target.setAutoAttach');
  assert.equal(nested.waitForDebuggerOnStart, true);
});

test('guards the targets already there while it installs, and leaves later running attaches alone', async () => {
  // Given a Chrome with a page open before the guard, reported while it installs.
  const chrome = fakeChrome({ whileInstalling: (attach) => attach('existing', 'page', false) });
  await installCaptureGuard(chrome.cdp);

  // When the runtime attaches to a tab itself afterwards (running, not paused).
  chrome.attach('runtime-own', 'page', false);
  await settle();

  // Then the existing page is guarded without a resume, and the runtime's own session is left alone.
  assert.deepEqual(methodsFor(chrome.sent, 'existing'), ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach']);
  assert.deepEqual(methodsFor(chrome.sent, 'runtime-own'), []);
});

test('closes a page Chrome refuses the guard for, but not one whose first page is only slow', async () => {
  // Given a Chrome that refuses the guard script.
  const refusing = fakeChrome({ refuse: ['Page.addScriptToEvaluateOnNewDocument'] });
  await installCaptureGuard(refusing.cdp);

  // When a page and a frame are attached, then the page is closed (a frame cannot be).
  refusing.attach('page-1', 'page', true);
  refusing.attach('frame-1', 'iframe', true);
  await settle();
  await settle();
  const closed = refusing.sent.filter(([, method]) => method === 'Target.closeTarget').map(([, , params]) => params.targetId);
  assert.deepEqual(closed, ['target-page-1']);

  // Given a new tab whose commands are answered only once its slow first page arrives.
  const slow = fakeChrome({ late: ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.runIfWaitingForDebugger'] });
  await installCaptureGuard(slow.cdp);

  // When the answers time out, then the tab stays open.
  slow.attach('popup', 'page', true);
  await settle();
  await settle();
  assert.equal(slow.sent.some(([, method]) => method === 'Target.closeTarget'), false);
});

test('stops guarding once cleaned up, and does not stay subscribed when Chrome refuses to auto-attach', async () => {
  // Given an installed guard that is then removed.
  const chrome = fakeChrome();
  const cleanup = await installCaptureGuard(chrome.cdp);
  cleanup();

  // Then nothing listens any more.
  assert.equal(chrome.listeners.size, 0);

  // When Chrome refuses browser-level auto-attach, then installing fails and leaves no listener.
  const refusing = fakeChrome({ refuse: ['Target.setAutoAttach'] });
  await assert.rejects(installCaptureGuard(refusing.cdp), /refused/);
  assert.equal(refusing.listeners.size, 0);
});

test('intercepts redirects and subframes before resuming targets', async () => {
  // Given a Chrome with host-owned origins.
  const chrome = fakeChrome();
  await installCaptureGuard(chrome.cdp, { openchamberOrigins: ['http://localhost:3000'] });
  // When new pages and cross-process frames attach and their requests pause.
  chrome.attach('page', 'page', true);
  chrome.attach('frame', 'iframe', true);
  await settle();
  for (const [sessionId, url] of [['page', 'http://127.1:3000/redirect'], ['frame', 'http://LOCALHOST.:3000/frame'], ['page', 'https://example.com']]) {
    for (const listener of chrome.listeners) listener({ method: 'Fetch.requestPaused', sessionId, params: { requestId: url, request: { url } } });
  }
  await settle();
  // Then interception precedes resume and every request has the right decision.
  for (const session of ['page', 'frame']) {
    const methods = methodsFor(chrome.sent, session);
    assert.equal(methods[0], 'Fetch.enable');
    assert.ok(methods.indexOf('Fetch.enable') < methods.indexOf('Runtime.runIfWaitingForDebugger'));
  }
  assert.deepEqual(chrome.sent.filter(([, method]) => method === 'Fetch.failRequest').map(([, , params]) => params.requestId), ['http://127.1:3000/redirect', 'http://LOCALHOST.:3000/frame']);
  assert.deepEqual(chrome.sent.filter(([, method]) => method === 'Fetch.continueRequest').map(([, , params]) => params.requestId), ['https://example.com']);
});

test('does not resume a target when Chrome refuses origin interception', async () => {
  // Given a Chrome that refuses interception.
  const chrome = fakeChrome({ refuse: ['Fetch.enable'] });
  await installCaptureGuard(chrome.cdp, { openchamberOrigins: ['http://localhost:3000'] });
  // When a page is attached paused.
  chrome.attach('page', 'page', true);
  await settle();
  // Then it never runs unprotected.
  assert.equal(methodsFor(chrome.sent, 'page').includes('Runtime.runIfWaitingForDebugger'), false);
});
