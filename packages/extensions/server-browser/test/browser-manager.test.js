import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserManager } from '../src/browser-manager.js';

const context = (directory, sessionId) => ({ directory, sessionId });

const createRuntimeFactory = () => {
  const runtimes = new Map();
  const factory = (scope, profile = null) => {
    const calls = [];
    const runtime = {
      calls,
      profile,
      async ensurePage() { calls.push(['ensure-page']); },
      controller: 'none',
      agentActive: false,
      title: '',
      url: 'about:blank',
      nativeSelectCompatibility: false,
      nativeSelectCompatibilityError: '',
      async perform(action, parameters) {
        calls.push(['perform', action, parameters]);
        if (action === 'browser.open') runtime.url = parameters.url;
        return { action, url: runtime.url };
      },
      async command(name, parameters) {
        calls.push(['command', name, parameters]);
        if (name === 'navigate') runtime.url = parameters.url;
      },
      async configureViewport(request) { calls.push(['viewport', request]); },
      async surfaceFrame({ after }) {
        calls.push(['frame', after]);
        return { sequence: 1, bytes: Buffer.from(scope.sessionId), mime: 'image/jpeg', width: 800, height: 600, title: runtime.title };
      },
      async surfaceInput(events, theme) { calls.push(['input', events, theme]); },
      surfaceControl(controller) { runtime.controller = controller; calls.push(['control', controller]); },
      async surfaceResize(size) { calls.push(['resize', size]); return size; },
      async surfaceClipboard() { return scope.sessionId; },
      async setNativeSelectCompatibility(enabled) {
        calls.push(['select-compatibility', enabled]);
        runtime.nativeSelectCompatibility = enabled;
        runtime.nativeSelectCompatibilityError = '';
      },
      zoomLevel: 0,
      async setZoomLevel(level) { calls.push(['zoom', level]); runtime.zoomLevel = level; },
      async pageEvaluate(expression, options) { calls.push(['evaluate', expression, options]); return `ran:${expression}`; },
      async pageCapture() { calls.push(['capture']); return { base64: 'AA==', mime: 'image/png', width: 10, height: 20 }; },
      async pageClear(what) { calls.push(['clear', what]); },
      async close(options) { calls.push(options?.save ? ['close', { save: true }] : ['close']); return null; },
      cookies: [],
      async exportCookies() { return runtime.cookies; },
      async importCookies(cookies) { calls.push(['import-cookies', cookies]); runtime.cookies = cookies; },
      deathListeners: new Set(),
      onDead(listener) {
        runtime.deathListeners.add(listener);
        return () => runtime.deathListeners.delete(listener);
      },
      die() {
        for (const listener of runtime.deathListeners) listener(new Error('Chrome exited'));
      },
      tabs: [],
      tabListeners: new Set(),
      onTabsChanged(listener) {
        runtime.tabListeners.add(listener);
        return () => runtime.tabListeners.delete(listener);
      },
      changeTabs() {
        for (const listener of runtime.tabListeners) listener();
      },
    };
    runtimes.set(scope.sessionId, runtime);
    return runtime;
  };
  return { factory, runtimes };
};

test('isolates actions by authoritative project and session context', async () => {
  // Given two different chat scopes.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });

  // When each chat opens a different URL.
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_two'));

  // Then each action reached a different runtime and the first scope stayed visible.
  assert.equal(runtimes.get('ses_one').url, 'https://one.test');
  assert.equal(runtimes.get('ses_two').url, 'https://two.test');
  assert.equal(manager.state().selectedScopeId, manager.state().scopes[0].id);
});

test('refuses an action when either authoritative context field is unknown', async () => {
  // Given a manager with an existing selected private scope.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://private.test' }, undefined, context('/repo', 'ses_private'));

  // When calls omit one or both context fields, then none reuse the private scope.
  await assert.rejects(manager.perform('browser.snapshot', {}, undefined, context('/repo', null)), /project and chat context/i);
  await assert.rejects(manager.perform('browser.snapshot', {}, undefined, context(null, 'ses_private')), /project and chat context/i);
  await assert.rejects(manager.perform('browser.snapshot', {}, undefined, context(null, null)), /project and chat context/i);
  assert.equal(runtimes.get('ses_private').calls.filter(([kind]) => kind === 'perform').length, 1);
});

test('keeps the selected view pinned when another chat acts', async () => {
  // Given one visible scope and a frame from it.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  const first = await manager.surfaceFrame({ after: 0, wait: 0 });

  // When another chat acts, then the visible frame remains from the first scope.
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_two'));
  const next = await manager.surfaceFrame({ after: first.sequence, wait: 0 });
  assert.equal(next, null);
  assert.equal(first.bytes.toString(), 'ses_one');
});

test('rebases frame sequences when the user selects another scope', async () => {
  // Given two runtimes whose source frames both start at sequence one.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_two'));
  const first = await manager.surfaceFrame({ after: 0, wait: 0 });
  const secondScope = manager.state().scopes.find((scope) => scope.sessionId === 'ses_two');

  // When the idle surface is switched, then the new frame is newer to the host.
  await manager.selectScope(secondScope.id, manager.state().generation);
  const second = await manager.surfaceFrame({ after: first.sequence, wait: 0 });
  assert.equal(second.bytes.toString(), 'ses_two');
  assert.ok(second.sequence > first.sequence);
});

test('serializes dock navigation and rejects it while any viewer owns control', async () => {
  // Given a selected scope and user control held through the host surface lease.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  manager.surfaceControl('user');

  // When the dock tries to navigate, then it cannot bypass that lease.
  await assert.rejects(manager.navigate('https://blocked.test'), /surface is idle/i);
  assert.equal(runtimes.get('ses_one').url, 'https://one.test');

  // When control is released, then the same dock action succeeds.
  manager.surfaceControl('none');
  await manager.navigate('https://allowed.test', manager.state().generation);
  assert.equal(runtimes.get('ses_one').url, 'https://allowed.test');
});

test('lets the viewer in control use the dock while other viewers only watch', async () => {
  // Given a selected scope that viewer A controls.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  await manager.surfaceControl('user', 'viewer-a');

  // When viewer B's dock navigates, then it is refused and B only watches.
  await assert.rejects(manager.navigate('https://b.test', manager.state().generation, { viewer: 'viewer-b' }), /surface is idle/i);
  assert.equal(manager.state({ viewer: 'viewer-b' }).viewerInControl, false);

  // When viewer A's dock navigates, then the command runs for the viewer in control.
  assert.equal(manager.state({ viewer: 'viewer-a' }).viewerInControl, true);
  await manager.navigate('https://a.test', manager.state().generation, { viewer: 'viewer-a' });
  assert.equal(runtimes.get('ses_one').url, 'https://a.test');

  // When A hands control back and C's input arrives ahead of its control notice, then C's dock can act.
  await manager.surfaceControl('none');
  assert.equal(manager.state({ viewer: 'viewer-a' }).viewerInControl, false);
  await manager.surfaceInput([{ type: 'text', text: 'c' }], { viewer: 'viewer-c', frameSeq: 0 });
  assert.equal(manager.state({ viewer: 'viewer-c' }).viewerInControl, true);
});

test('lets anyone answer a page\'s dialog or file request unless another person holds control', async () => {
  // Given a selected scope whose page asks for something, with an agent action waiting on the queue.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  runtime.answerDialog = async (answer) => { runtime.calls.push(['dialog', answer]); };
  runtime.answerFileChooser = async (answer) => { runtime.calls.push(['chooser', answer]); };
  let releaseAction;
  runtime.perform = () => new Promise((resolve) => { releaseAction = resolve; });
  const waiting = manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));

  // When a dock answers while the agent works, then the answer is not held behind the agent's action.
  await manager.pageDialog({ tabId: 't1', dialogId: 2, accept: true }, { viewer: null });
  await manager.pageFileChooser({ tabId: 't1', chooserId: 3, files: null }, { viewer: 'viewer-b' });
  releaseAction({});
  await waiting;

  // When a person holds control, then only that person's dock answers.
  await manager.surfaceControl('user', 'viewer-a');
  await assert.rejects(manager.pageDialog({ tabId: 't1', dialogId: 4, accept: false }, { viewer: 'viewer-b' }), /surface is idle/i);
  await manager.pageDialog({ tabId: 't1', dialogId: 4, accept: false }, { viewer: 'viewer-a' });
  assert.deepEqual(runtime.calls.filter(([name]) => name === 'dialog' || name === 'chooser'), [
    ['dialog', { tabId: 't1', dialogId: 2, accept: true, promptText: undefined }],
    ['chooser', { tabId: 't1', chooserId: 3, files: null }],
    ['dialog', { tabId: 't1', dialogId: 4, accept: false, promptText: undefined }],
  ]);
});

test('starts a listener at the newest sound and follows it from there, per scope', async () => {
  // Given a selected scope whose sound is at packet 40.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  runtime.audioHead = 40;
  const asked = [];
  runtime.surfaceAudio = async ({ after }) => {
    asked.push(after);
    return { seq: after + 2, codec: 'opus', sampleRate: 48_000, channels: 2, bytes: Buffer.from([0, 1, 7]) };
  };

  // When a listener starts, then it gets what comes after the newest packet, under the manager's own numbers.
  const first = await manager.surfaceAudio({ after: 0, wait: 0 });
  assert.equal(first.seq, 1);

  // When it asks for more, then it continues where the last answer ended.
  const second = await manager.surfaceAudio({ after: first.seq, wait: 0 });
  assert.equal(second.seq, 2);
  assert.deepEqual(asked, [40, 42]);

  // When another scope becomes the view, then its sound starts at its own newest packet.
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_two'));
  const other = runtimes.get('ses_two');
  other.audioHead = 7;
  other.surfaceAudio = async ({ after }) => {
    asked.push(after);
    return null;
  };
  await manager.selectScope(manager.state().scopes.find((scope) => scope.sessionId === 'ses_two').id, manager.state().generation, {});
  assert.equal(await manager.surfaceAudio({ after: second.seq, wait: 0 }), null);
  assert.deepEqual(asked, [40, 42, 7]);
});

test('starts a reopened browser\'s sound at its own newest packet', async () => {
  // Given a listener that has heard a chat's browser up to its packet 42.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  const asked = [];
  const listen = (runtime, head) => {
    runtime.audioHead = head;
    runtime.surfaceAudio = async ({ after }) => {
      asked.push(after);
      return { seq: after + 2, codec: 'opus', sampleRate: 48_000, channels: 2, bytes: Buffer.from([0, 1, 7]) };
    };
  };
  listen(runtimes.get('ses_one'), 40);
  const heard = await manager.surfaceAudio({ after: 0, wait: 0 });

  // When that browser is closed and the chat opens a new one under the same scope.
  const scope = manager.state().scopes[0];
  await manager.closeScope(scope.id, manager.state().generation, {});
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  listen(runtimes.get('ses_one'), 3);
  if (manager.state().selectedScopeId !== scope.id) await manager.selectScope(scope.id, manager.state().generation, {});

  // Then the listener continues from the new browser's newest packet, not the old browser's number.
  await manager.surfaceAudio({ after: heard.seq, wait: 0 });
  assert.deepEqual(asked, [40, 3]);
});

test('refuses input and dock commands made on a picture of an earlier view', async () => {
  // Given a frame the viewer drew from the first chat's browser.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));
  const first = await manager.surfaceFrame({ after: 0, wait: 0 });
  const inputs = () => runtimes.get('ses_two').calls.filter(([kind]) => kind === 'input').map(([, events]) => events[0].text);

  // When the view switches to the second chat, then input and a dock command made on that frame are refused.
  await manager.selectScope(manager.state().scopes[1].id, manager.state().generation);
  await assert.rejects(manager.surfaceInput([{ type: 'text', text: 'late' }], { viewer: 'viewer-a', frameSeq: first.sequence }), /view changed/);
  await manager.surfaceControl('none');
  await assert.rejects(manager.reload(manager.state().generation, { frameSeq: first.sequence }), /view changed/);

  // When the viewer draws the new view, or has drawn nothing yet, then its input applies.
  const second = await manager.surfaceFrame({ after: first.sequence, wait: 0 });
  await manager.surfaceInput([{ type: 'text', text: 'seen' }], { viewer: 'viewer-a', frameSeq: second.sequence });
  await manager.surfaceInput([{ type: 'text', text: 'blind' }], { viewer: 'viewer-a', frameSeq: 0 });

  // When the page brings another tab forward, then input made on the old tab's frame is refused.
  runtimes.get('ses_two').tabs = [{ id: 'tab-2', active: true }];
  await assert.rejects(manager.surfaceInput([{ type: 'text', text: 'other-tab' }], { viewer: 'viewer-a', frameSeq: second.sequence }), /view changed/);
  assert.deepEqual(inputs(), ['seen', 'blind']);
});

test('preserves every scope and refuses new work at the configured bound', async () => {
  // Given a manager bounded to two browser runtimes.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory, maxScopes: 2 });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));

  // When a third scope arrives, then it is refused without destroying browser state.
  await assert.rejects(
    manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_three')),
    /scope limit \(2\)/i,
  );
  assert.deepEqual(manager.state().scopes.map((scope) => scope.sessionId), ['ses_one', 'ses_two']);
  assert.equal(runtimes.get('ses_one').calls.some(([kind]) => kind === 'close'), false);
  assert.equal(runtimes.get('ses_two').calls.some(([kind]) => kind === 'close'), false);
});

test('discards a frame that resolves after the selected view changes twice', async () => {
  // Given a pending frame from the first scope and another available scope.
  const pendingFrame = Promise.withResolvers();
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));
  runtimes.get('ses_one').surfaceFrame = () => pendingFrame.promise;
  const waiting = manager.surfaceFrame({ after: 0, wait: 25_000 });
  const scopes = manager.state().scopes;

  // When the view moves away and back before the old frame resolves, then that frame is stale.
  await manager.selectScope(scopes[1].id, manager.state().generation);
  await manager.selectScope(scopes[0].id, manager.state().generation);
  pendingFrame.resolve({ sequence: 1, bytes: Buffer.from('stale'), mime: 'image/jpeg', width: 800, height: 600, title: '' });
  assert.equal(await waiting, null);
});

test('routes queued surface input to the view that remains selected', async () => {
  // Given two scopes while the first remains pinned.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));

  // When surface input arrives after background work, then only the selected scope receives it.
  await manager.surfaceInput([{ type: 'text', text: 'visible' }]);
  assert.equal(runtimes.get('ses_one').calls.some(([kind]) => kind === 'input'), true);
  assert.equal(runtimes.get('ses_two').calls.some(([kind]) => kind === 'input'), false);
});

test('cancels a static old view frame wait when another scope is selected', async () => {
  // Given a frame request waiting on a static selected page.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));
  runtimes.get('ses_one').surfaceFrame = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const waiting = manager.surfaceFrame({ after: 0, wait: 25_000 });

  // When the dock selects the second scope, then the old long poll ends immediately.
  await manager.selectScope(manager.state().scopes[1].id, manager.state().generation);
  assert.equal(await waiting, null);
});

test('marks user ownership before queued surface input reaches Chrome', async () => {
  // Given an agent action already running in the selected scope.
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  runtimes.get('ses_one').perform = async () => {
    started.resolve();
    await finish.promise;
    return {};
  };
  const action = manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await started.promise;

  // When trusted surface input arrives first, then dock mutations see user ownership immediately.
  const input = manager.surfaceInput([{ type: 'text', text: 'x' }]);
  assert.equal(manager.state().controller, 'user');
  finish.resolve();
  await action;
  await input;
});

test('rejects a dock command captured for an older selected view', async () => {
  // Given a dock request captured before the user changes the selected scope.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));
  const staleGeneration = manager.state().generation;
  await manager.selectScope(manager.state().scopes[1].id, staleGeneration);

  // When the old request reaches the queue, then it cannot navigate the new view.
  await assert.rejects(manager.navigate('https://stale.test', staleGeneration), /view changed/i);
  assert.equal(runtimes.get('ses_two').url, 'about:blank');
});

test('holds an empty surface request until the first scope exists', async () => {
  // Given a host frame request before any agent has created a browser scope.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  let settled = false;
  const waiting = manager.surfaceFrame({ after: 0, wait: 25_000 }).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  // When the first scoped action arrives, then the held request wakes for an immediate repoll.
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  assert.equal(await waiting, null);
});

test('shows a selected scope at once and applies the current viewer size to it next', async () => {
  // Given a resized viewer and a background scope with its own agent viewport.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.surfaceResize({ width: 700, height: 500 });
  await manager.perform('browser.resize', { viewport: 'desktop' }, undefined, context('/repo', 'ses_two'));

  // When the user selects that scope, then it is visible and gets the surface size right after.
  await manager.selectScope(manager.state().scopes[1].id, manager.state().generation);
  assert.equal(manager.state().selectedScopeId, manager.state().scopes[1].id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtimes.get('ses_two').calls.at(-1), ['resize', { width: 700, height: 500, scale: 1 }]);
});

test('reload and stop preserve the selected scope and enforce idle and generation guards', async () => {
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  const before = manager.state();
  await manager.reload(before.generation);
  await manager.stop(before.generation);
  assert.equal(manager.state().selectedScopeId, before.selectedScopeId);
  assert.deepEqual(runtimes.get('ses_one').calls.slice(-2), [['command', 'reload', {}], ['command', 'stop', {}]]);
  await assert.rejects(manager.reload(before.generation + 1), /view changed/);
  await manager.surfaceControl('user');
  await assert.rejects(manager.stop(before.generation), /idle/);
  assert.equal(runtimes.get('ses_one').calls.filter((call) => call[0] === 'command').length, 2);
  await manager.close();
});

test('keeps native select compatibility scoped and applies dock mutation guards', async () => {
  // Given two independent browser scopes with the first selected.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));
  const generation = manager.state().generation;

  // When compatibility is enabled from the dock, then only the selected scope changes.
  await manager.setNativeSelectCompatibility(true, generation);
  assert.equal(manager.state().scopes[0].nativeSelectCompatibility, true);
  assert.equal(manager.state().scopes[1].nativeSelectCompatibility, false);
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['select-compatibility', true]);

  // Then stale or leased dock commands cannot mutate either scope.
  await assert.rejects(manager.setNativeSelectCompatibility(false, generation + 1), /view changed/i);
  await manager.surfaceControl('user');
  await assert.rejects(manager.setNativeSelectCompatibility(false, generation), /surface is idle/i);
  assert.equal(manager.state().scopes[0].nativeSelectCompatibility, true);
});

test('rolls back native select compatibility when surface control changes during the mutation', async () => {
  // Given a compatibility mutation paused after it starts.
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  const originalSet = runtime.setNativeSelectCompatibility;
  let calls = 0;
  runtime.setNativeSelectCompatibility = async (enabled) => {
    calls += 1;
    if (calls === 1) {
      started.resolve();
      await finish.promise;
    }
    await originalSet(enabled);
  };

  // When user input takes control before the mutation completes.
  const mutation = manager.setNativeSelectCompatibility(true, manager.state().generation);
  await started.promise;
  const input = manager.surfaceInput([{ type: 'text', text: 'control' }]);
  finish.resolve();

  // Then the dock request fails and restores the previous setting before input runs.
  await assert.rejects(mutation, /surface is idle/i);
  await input;
  assert.equal(manager.state().scopes[0].nativeSelectCompatibility, false);
  assert.deepEqual(runtime.calls.filter(([kind]) => kind === 'select-compatibility'), [
    ['select-compatibility', true],
    ['select-compatibility', false],
  ]);
});


test('discards a scope whose Chrome died and starts a fresh one on the next action', async () => {
  // Given a visible scope.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  const first = runtimes.get('ses_one');
  const generation = manager.state().generation;

  // When its Chrome dies.
  first.die();
  await manager.surfaceControl('none');

  // Then the scope, its selection, and its runtime are gone, and the dock learns why.
  const afterDeath = manager.state();
  assert.deepEqual(afterDeath.scopes, []);
  assert.equal(afterDeath.selectedScopeId, null);
  assert.ok(afterDeath.generation > generation);
  assert.equal(afterDeath.notice.sessionId, 'ses_one');
  assert.match(afterDeath.notice.message, /stopped unexpectedly/);
  assert.deepEqual(first.calls.at(-1), ['close']);

  // When the same chat acts again, then a fresh runtime serves it and becomes visible.
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_one'));
  const recreated = manager.state();
  assert.notEqual(runtimes.get('ses_one'), first);
  assert.equal(recreated.scopes.length, 1);
  assert.equal(recreated.notice, null);
  assert.equal(recreated.selectedScopeId, recreated.scopes[0].id);
});

test('guards tab commands and treats a tab switch in the visible scope as a view change', async () => {
  // Given two scopes with the first one visible.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));
  const generation = manager.state().generation;

  // When the dock opens, selects, and closes tabs, then each command reaches the visible runtime.
  await manager.newTab(generation);
  await manager.selectTab('tab-2', generation);
  await manager.closeTab('tab-2', generation);
  assert.deepEqual(runtimes.get('ses_one').calls.filter(([kind]) => kind === 'command'), [
    ['command', 'tab-new', {}],
    ['command', 'tab-select', { tabId: 'tab-2' }],
    ['command', 'tab-close', { tabId: 'tab-2' }],
  ]);

  // When a background scope switches tabs, then the visible view is unchanged.
  runtimes.get('ses_two').changeTabs();
  assert.equal(manager.state().generation, generation);

  // When the visible scope switches tabs, then commands captured before it are refused.
  runtimes.get('ses_one').changeTabs();
  await assert.rejects(manager.newTab(generation), /view changed/i);

  // When a viewer holds control, then tab commands wait for the surface to be idle.
  manager.surfaceControl('user');
  await assert.rejects(manager.newTab(manager.state().generation), /idle/i);
});

test('converts the viewer panel with its pixel ratio and sizes a first scope created after it', async () => {
  // Given a panel on a 2x display measured before any scope exists.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.setDevicePixelRatio(2);
  await assert.rejects(manager.surfaceResize({ width: 1400, height: 1000 }), /no browser scope/i);

  // When the first scope appears, then it gets the panel's CSS size.
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  assert.deepEqual(runtime.calls.find(([kind]) => kind === 'resize'), ['resize', { width: 700, height: 500, scale: 2 }]);

  // When the window moves to a 1x display, then the page keeps its CSS size but renders at the new density, and the host's next measurement uses the new ratio.
  await manager.setDevicePixelRatio(1);
  assert.deepEqual(runtime.calls.at(-1), ['resize', { width: 700, height: 500, scale: 1 }]);
  await manager.surfaceResize({ width: 800, height: 600 });
  assert.deepEqual(runtime.calls.at(-1), ['resize', { width: 800, height: 600, scale: 1 }]);

  // When the dock sets a viewport, then it is marked as the viewer's and guarded like other dock mutations.
  await manager.setViewport({ mode: 'fixed', width: 500, height: 400, mobile: false }, manager.state().generation);
  assert.deepEqual(runtime.calls.at(-1), ['viewport', { mode: 'fixed', source: 'viewer', width: 500, height: 400, mobile: false }]);
  await assert.rejects(manager.setViewport({ mode: 'auto', mobile: false }, manager.state().generation + 1), /view changed/i);
});

test('works out a panel measured before the dock reported its pixel ratio once the ratio arrives', async () => {
  // Given a visible scope whose panel the host measured before the dock reported a 2x ratio.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  await manager.surfaceResize({ width: 1400, height: 1000 });

  // When the ratio arrives, then the page gets the panel's CSS size.
  await manager.setDevicePixelRatio(2);
  assert.deepEqual(runtime.calls.at(-1), ['resize', { width: 700, height: 500, scale: 2 }]);
});

test('lists the visible tab\'s errors and warnings only for a dock whose console is open', async () => {
  // Given a manager with no browser yet, and then a visible scope whose page logged an error.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  assert.deepEqual(manager.state({}, { problems: true }).consoleProblems, []);
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  runtimes.get('ses_one').consoleProblems = () => [{ level: 'error', message: 'boom', source: 'console' }];

  // When a dock asks with its console open, then the list comes along; otherwise it stays out of the poll.
  assert.deepEqual(manager.state({}, { problems: true }).consoleProblems, [{ level: 'error', message: 'boom', source: 'console' }]);
  assert.equal('consoleProblems' in manager.state(), false);
});

test('hands the viewer theme to surface input and reports a pending copy from the visible scope', async () => {
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const theme = { dark: true, properties: {} };

  manager.setViewerTheme(theme);
  await manager.surfaceInput([{ type: 'text', text: 'x' }]);
  runtimes.get('ses_one').copyRequest = { id: 'copy-1', text: 'hello' };

  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['input', [{ type: 'text', text: 'x' }], theme]);
  assert.deepEqual(manager.state().copy, { id: 'copy-1', text: 'hello' });
});

test('expires idle scopes and makes room by evicting the least recently active idle scope', async () => {
  // Given a two-scope bound, a controllable clock, and a captured sweep timer.
  let clock = 0;
  const timers = [];
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({
    createRuntime: factory,
    maxScopes: 2,
    now: () => clock,
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  clock = 10_000;
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_two'));

  // When a third chat arrives while both were active in the last minute, then it is refused.
  clock = 30_000;
  await assert.rejects(
    manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_three')),
    /scope limit \(2\)/i,
  );

  // When a minute has passed, then the least recently active scope makes room.
  clock = 75_000;
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_three'));
  assert.deepEqual(manager.state().scopes.map((scope) => scope.sessionId), ['ses_two', 'ses_three']);
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['close']);

  // When five idle minutes pass, then the sweep closes only the scope that stayed idle.
  clock = 10_000 + 5 * 60_000;
  timers.shift()();
  await manager.surfaceControl('none');
  assert.deepEqual(manager.state().scopes.map((scope) => scope.sessionId), ['ses_three']);
  assert.deepEqual(runtimes.get('ses_two').calls.at(-1), ['close']);
});

test('opens the viewed chat\'s browser from the dock without waiting for an agent action', async () => {
  // Given one scope created by an agent action.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));

  // When the dock opens another chat's browser, then that scope exists and becomes visible.
  await manager.openScope(context('/repo', 'ses_two'), manager.state().generation);
  assert.equal(manager.state().selectedScopeId, manager.state().scopes[1].id);
  assert.equal(runtimes.get('ses_two').calls.some(([kind]) => kind === 'perform'), false);

  // When it is opened again, then nothing is duplicated.
  await manager.openScope(context('/repo', 'ses_two'), manager.state().generation);
  assert.equal(manager.state().scopes.length, 2);

  // Then stale views, missing context, and a busy surface are refused.
  await assert.rejects(manager.openScope(context('/repo', 'ses_three'), manager.state().generation + 1), /view changed/i);
  await assert.rejects(manager.openScope({ directory: '/repo', sessionId: '' }, manager.state().generation), /project and chat context/i);
  manager.surfaceControl('user');
  await assert.rejects(manager.openScope(context('/repo', 'ses_three'), manager.state().generation), /idle/i);
});

test('closes browsers at once on shutdown instead of waiting behind a stuck action', { timeout: 2_000 }, async () => {
  // Given an action waiting on Chrome, like a command a hung page never answers, that fails once its browser closes.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  let failStuck;
  runtime.perform = () => new Promise((_resolve, reject) => { failStuck = reject; });
  runtime.close = async () => {
    runtime.calls.push(['close']);
    failStuck(new Error('CDP connection is closed'));
  };
  const stuck = assert.rejects(manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one')), /connection is closed/);
  await new Promise((resolve) => setImmediate(resolve));

  // When the service stops, then the browser closes without waiting for that action to settle.
  await manager.close();
  assert.equal(runtime.calls.some(([kind]) => kind === 'close'), true);
  await stuck;
});
const fakeProfiles = (bindings) => {
  const profiles = new Map([['p1', { id: 'p1', name: 'Work' }], ['p2', { id: 'p2', name: 'Client X' }]]);
  const removed = [];
  return {
    removed,
    revoked: false,
    versions: new Map([['p1', 0], ['p2', 0]]),
    async resolve(directory) {
      const id = bindings[directory];
      return id ? profiles.get(id) : null;
    },
    async get(id) {
      if (!profiles.has(id)) throw new Error('That profile no longer exists');
      return profiles.get(id);
    },
    async version(id) { return this.versions.get(id); },
    async list() { return [...profiles.values()]; },
    async create(name) {
      const profile = { id: `p${profiles.size + 1}`, name };
      profiles.set(profile.id, profile);
      this.versions.set(profile.id, 0);
      return profile;
    },
    async bind(id, directory) { bindings[directory] = id; return profiles.get(id); },
    async remove(id) { removed.push(id); profiles.delete(id); },
    async revokeAll() { this.revoked = true; profiles.clear(); },
  };
};

// Runtimes that behave like copies: they remember the version they were
// taken at and refuse to save over a newer one.
const copyRuntimes = (store) => {
  const { factory, runtimes } = createRuntimeFactory();
  const all = [];
  const copies = (scope, profile) => {
    const runtime = factory(scope, profile);
    all.push(runtime);
    if (!profile) return runtime;
    runtime.profileVersion = store.versions.get(profile.id);
    const close = runtime.close;
    runtime.close = async (options) => {
      await close(options);
      if (!options?.save) return null;
      if (store.versions.get(profile.id) !== runtime.profileVersion) throw Object.assign(new Error('stale'), { code: 'STALE_PROFILE' });
      const version = runtime.profileVersion + 1;
      store.versions.set(profile.id, version);
      return version;
    };
    return runtime;
  };
  return { factory: copies, runtimes, all };
};

test('gives every chat of a bound project its own copy of the profile, in parallel', async () => {
  // Given /work bound to the Work profile.
  const store = fakeProfiles({ '/work': 'p1' });
  const { factory, runtimes } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });

  // When two chats in the project and one elsewhere act at the same time.
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/work', 'ses_one'));
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/work', 'ses_two'));
  await manager.perform('browser.open', { url: 'https://three.test' }, undefined, context('/other', 'ses_three'));

  // Then both project chats run on copies of Work, the other on a throwaway browser, and nobody waits.
  assert.deepEqual(runtimes.get('ses_one').profile, { id: 'p1', name: 'Work' });
  assert.deepEqual(runtimes.get('ses_two').profile, { id: 'p1', name: 'Work' });
  assert.equal(runtimes.get('ses_three').profile, null);

  // And a snapshot says who else uses the profile, and closing a chat never saves its copy.
  const snapshot = await manager.perform('browser.snapshot', {}, undefined, context('/work', 'ses_one'));
  assert.deepEqual(snapshot.profile, { name: 'Work', copyVersion: 0, alsoUsedBy: [{ directory: '/work', sessionId: 'ses_two' }] });
  const listed = (await manager.listProfiles()).find((profile) => profile.id === 'p1');
  assert.deepEqual(listed.chats.map((chat) => chat.sessionId), ['ses_one', 'ses_two']);
  await manager.close();
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['close']);
  assert.equal(store.versions.get('p1'), 0);
});

test('saves a chat\'s copy into the profile and continues on it with its tabs reopened', async () => {
  const store = fakeProfiles({ '/work': 'p1' });
  const { factory, all } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  await manager.perform('browser.open', { url: 'https://login.test' }, undefined, context('/work', 'ses_one'));
  const first = all[0];
  first.tabs = [{ id: 't1', url: 'https://login.test/', active: true }, { id: 't2', url: 'https://app.test/', active: false }];

  // When the agent saves, then the copy is saved, and the chat runs on a new browser with both pages.
  const saved = await manager.saveProfile({}, undefined, context('/work', 'ses_one'));
  assert.equal(saved.saved, true);
  assert.equal(saved.version, 1);
  assert.equal(saved.reopenedTabs, 2);
  assert.deepEqual(first.calls.at(-1), ['close', { save: true }]);
  const second = all[1];
  assert.deepEqual(second.calls.filter(([name]) => name === 'perform').map(([, action, parameters]) => [action, parameters.url]), [
    ['browser.open', 'https://login.test/'],
    ['browser.open', 'https://app.test/'],
  ]);
  assert.equal(second.profileVersion, 1);

  // A chat without a profile has nothing to save.
  await assert.rejects(manager.saveProfile({}, undefined, context('/other', 'ses_x')), /does not use a saved profile/);
});

test('tells a chat whose project was bound after its browser started how to get onto the profile', async () => {
  // Given a chat browsing before its project is bound, then bound to Work.
  const bindings = {};
  const store = fakeProfiles(bindings);
  const { factory, runtimes } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  await manager.perform('browser.open', { url: 'https://app.test' }, undefined, context('/late', 'ses_one'));
  bindings['/late'] = 'p1';

  // When the agent saves, then nothing is saved and the error names the profile and the way onto it.
  await assert.rejects(
    manager.saveProfile({}, undefined, context('/late', 'ses_one')),
    /started before its project was bound to the browser profile "Work".*Close this chat's browser/s,
  );
  assert.equal(store.versions.get('p1'), 0);
  assert.equal(runtimes.get('ses_one').calls.some(([name]) => name === 'close'), false);
});

test('refuses to save a copy taken before another chat saved, and gives the chat a fresh copy', async () => {
  // Given two chats on copies of version 0, and the first one saves.
  const store = fakeProfiles({ '/work': 'p1' });
  const { factory, runtimes } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/work', 'ses_one'));
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/work', 'ses_two'));
  const staleCopy = runtimes.get('ses_two');
  staleCopy.tabs = [{ id: 't9', url: 'https://two.test/', active: true }];
  await manager.saveProfile({}, undefined, context('/work', 'ses_one'));

  // When the second chat saves its older copy, then it is refused, not saved over the first save.
  await assert.rejects(manager.saveProfile({}, undefined, context('/work', 'ses_two')), /Another chat saved the browser profile "Work".*Redo your change/s);
  assert.equal(store.versions.get('p1'), 1);
  assert.deepEqual(staleCopy.calls.at(-1), ['close']);

  // Then the second chat already runs on a fresh copy of the saved version, on its page.
  const fresh = runtimes.get('ses_two');
  assert.notEqual(fresh, staleCopy);
  assert.equal(fresh.profileVersion, 1);
  assert.equal(fresh.url, 'https://two.test/');
});

test('opens a profile for signing in, saves it on close, and deleting or revoking never saves', async () => {
  const store = fakeProfiles({ '/work': 'p1' });
  const { factory, runtimes } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });

  // When the dock opens the Work profile to sign in, then it becomes the visible browser on a copy of it.
  const scopeId = await manager.openProfile('p1', 0, {});
  const state = manager.state();
  assert.equal(state.selectedScopeId, scopeId);
  assert.equal(state.scopes[0].signIn, true);
  assert.equal((await manager.listProfiles()).find((profile) => profile.id === 'p1').signingIn, true);

  // Agents keep working meanwhile, on their own copies.
  await manager.perform('browser.snapshot', {}, undefined, context('/work', 'ses_one'));
  assert.deepEqual(runtimes.get('ses_one').profile, { id: 'p1', name: 'Work' });

  // An agent cannot open the sign-in pseudo-project itself.
  await assert.rejects(
    manager.perform('browser.snapshot', {}, undefined, context('profile:p2', 'sign-in')),
    /from the Server Browser page/,
  );

  // When the person saves and closes, then the profile moves to a new version.
  await manager.closeProfile('p1');
  assert.equal(store.versions.get('p1'), 1);
  await assert.rejects(manager.closeProfile('p1'), /not open for signing in/);

  // When the profile is deleted, then its browsers close without saving and the store forgets it.
  await manager.deleteProfile('p1');
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['close']);
  assert.deepEqual(store.removed, ['p1']);

  // When everything is revoked, then every profile browser closes unsaved and the store is wiped.
  await manager.openProfile('p2', manager.state().generation, {});
  const signIn = runtimes.get('sign-in');
  await manager.revokeAllProfiles();
  assert.deepEqual(signIn.calls.at(-1), ['close']);
  assert.equal(store.revoked, true);
  assert.equal(store.versions.get('p2'), 0);
});

test('a login request opens the profile for signing in on the chat\'s page and continues on a fresh copy once saved', async () => {
  // Given a chat stuck on a login page.
  const store = fakeProfiles({ '/work': 'p1' });
  const { factory, runtimes, all } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  await manager.perform('browser.open', { url: 'https://app.test/login' }, undefined, context('/work', 'ses_one'));
  const stuck = runtimes.get('ses_one');
  stuck.tabs = [{ id: 't1', url: 'https://app.test/login', active: true }];

  // When the agent asks for a login.
  const asked = manager.requestHelp({ reason: 'Sign in to app.test', timeoutSeconds: 60, kind: 'login' }, undefined, context('/work', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Then the profile's sign-in browser is what the viewer sees, opened on that page.
  const signIn = runtimes.get('sign-in');
  const state = manager.state();
  assert.equal(state.selectedScopeId, state.scopes.find((scope) => scope.signIn).id);
  assert.equal(state.help.kind, 'login');
  assert.deepEqual(signIn.calls.find(([name, command]) => name === 'command' && command === 'navigate'), ['command', 'navigate', { url: 'https://app.test/login' }]);

  // When the person signs in and saves, then the chat continues on a fresh copy of the saved profile.
  await manager.closeProfile('p1');
  const result = await asked;
  assert.equal(result.outcome, 'signed-in');
  const fresh = runtimes.get('ses_one');
  assert.notEqual(fresh, stuck);
  assert.equal(fresh.profileVersion, 1);
  assert.equal(fresh.url, 'https://app.test/login');
  assert.deepEqual(stuck.calls.at(-1), ['close']);
  assert.equal(manager.state().help, null);
  assert.ok(all.length >= 3);
});

test('asks the person before keeping a chat\'s logins in a new profile, then moves the chat onto it', async () => {
  // Given a chat in an unbound project, logged into a site, with two pages.
  const bindings = {};
  const store = fakeProfiles(bindings);
  const { factory, runtimes, all } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  await manager.perform('browser.open', { url: 'https://app.test' }, undefined, context('/acme', 'ses_one'));
  const throwaway = runtimes.get('ses_one');
  throwaway.tabs = [{ id: 't1', url: 'https://app.test/home', active: true }, { id: 't2', url: 'https://app.test/docs', active: false }];
  throwaway.cookies = [{ name: 'session', value: 'abc', domain: 'app.test', path: '/' }];

  // When the agent asks to keep its logins in "Acme".
  const asked = manager.requestHelp({ reason: 'Keep the app.test login', timeoutSeconds: 60, kind: 'profile', profileName: 'Acme' }, undefined, context('/acme', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Then nothing changed yet: the panel shows the request, and no profile exists or is bound.
  assert.deepEqual(manager.state().help.profile, { name: 'Acme', exists: false });
  assert.equal(manager.state().help.kind, 'profile');
  assert.equal((await store.list()).some((profile) => profile.name === 'Acme'), false);
  assert.equal(bindings['/acme'], undefined);

  // When the person allows it.
  manager.answerProfileRequest(true, {});
  const result = await asked;

  // Then the profile exists, the project is bound, the cookies went into a copy that was saved, and the chat runs on a fresh copy with its pages.
  const acme = (await store.list()).find((profile) => profile.name === 'Acme');
  assert.equal(bindings['/acme'], acme.id);
  assert.equal(result.outcome, 'approved');
  assert.equal(result.profileSaved, true);
  assert.equal(result.carriedCookies, 1);
  assert.equal(store.versions.get(acme.id), 1);
  const copy = all.find((runtime) => runtime.calls.some(([name]) => name === 'import-cookies'));
  assert.deepEqual(copy.calls.find(([name]) => name === 'import-cookies')[1], throwaway.cookies);
  assert.deepEqual(copy.calls.at(-1), ['close', { save: true }]);
  const fresh = runtimes.get('ses_one');
  assert.notEqual(fresh, copy);
  assert.equal(fresh.profileVersion, 1);
  assert.deepEqual(fresh.calls.filter(([name]) => name === 'perform').map(([, , parameters]) => parameters.url), ['https://app.test/home', 'https://app.test/docs']);
  assert.equal(manager.state().help, null);
});

test('changes nothing when the person declines a profile request, and refuses an answer nobody asked for', async () => {
  const bindings = {};
  const store = fakeProfiles(bindings);
  const { factory, runtimes } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  assert.throws(() => manager.answerProfileRequest(true, {}), /No profile request is waiting/);

  // When the agent asks to use the existing Work profile and the person declines.
  const asked = manager.requestHelp({ reason: 'Keep the login', timeoutSeconds: 60, kind: 'profile', profileName: 'work' }, undefined, context('/repo', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.state().help.profile, { name: 'Work', exists: true });
  manager.answerProfileRequest(false, {});

  // Then the answer says so, and the chat keeps its own browser, unbound.
  const result = await asked;
  assert.equal(result.outcome, 'declined');
  assert.equal(bindings['/repo'], undefined);
  assert.equal(runtimes.get('ses_one').calls.some(([name]) => name === 'close'), false);
  assert.equal(store.versions.get('p1'), 0);
});

test('asks the person for help on the chat\'s tab and resumes when they hand back', async () => {
  // Given a chat with a background tab, and the viewer on another chat.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://other.test' }, undefined, context('/repo', 'ses_other'));
  await manager.perform('browser.open', { url: 'https://login.test' }, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  runtime.tabs = [{ id: 't1', active: true }, { id: 't2', active: false }];
  const generation = manager.state().generation;

  // When the agent asks for help on the background tab.
  const asked = manager.requestHelp({ tabId: 't2', reason: 'Enter the one-time code', timeoutSeconds: 60 }, undefined, context('/repo', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));

  // Then that chat and tab are what the viewer sees, and the dock shows the request.
  const state = manager.state();
  assert.equal(state.selectedScopeId, state.scopes.find((scope) => scope.sessionId === 'ses_one').id);
  assert.ok(state.generation > generation);
  assert.deepEqual(runtime.calls.find(([name, command]) => name === 'command' && command === 'tab-select'), ['command', 'tab-select', { tabId: 't2' }]);
  assert.equal(state.help.reason, 'Enter the one-time code');

  // When the person takes control and hands it back, then the agent resumes.
  await manager.surfaceControl('user', 'viewer-a');
  await manager.surfaceControl('none');
  const result = await asked;
  assert.equal(result.outcome, 'handed-back');
  assert.equal(result.profileSaved, undefined);
  assert.equal(manager.state().help, null);
});

test('a login request in a chat without a profile hands the page over and says the login was not saved', async () => {
  // Given a chat whose project is bound to no profile.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory, profiles: fakeProfiles({}) });

  // When the agent asks for a login and the person hands back.
  const asked = manager.requestHelp({ reason: 'Sign in', timeoutSeconds: 60, kind: 'login' }, undefined, context('/repo', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await manager.surfaceControl('user', 'viewer-a');
  await manager.surfaceControl('none');

  // Then the answer says nothing outlives the chat's browser.
  const result = await asked;
  assert.equal(result.outcome, 'handed-back');
  assert.equal(result.profileSaved, false);
  assert.match(result.note, /not saved anywhere/);
});

test('stops waiting for help at its time limit or when cancelled', async () => {
  const timers = [];
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({
    createRuntime: factory,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimer: () => {},
  });

  // When nobody takes control before the time limit, then the answer says so.
  const asked = manager.requestHelp({ reason: 'Solve the CAPTCHA', timeoutSeconds: 30 }, undefined, context('/repo', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));
  timers.find((timer) => timer.delay === 30_000).callback();
  assert.equal((await asked).outcome, 'timeout');

  // When the host cancels the call, then the wait ends with the cancellation.
  const controller = new AbortController();
  const cancelled = manager.requestHelp({ reason: 'Sign in', timeoutSeconds: 30 }, controller.signal, context('/repo', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new DOMException('Browser action was cancelled', 'AbortError'));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(manager.state().help, null);

  // While the person holds the browser, a new request is refused like any agent action.
  await manager.surfaceControl('user', 'viewer-a');
  await assert.rejects(manager.requestHelp({ reason: 'x', timeoutSeconds: 30 }, undefined, context('/repo', 'ses_one')), /user controls the browser/);
});

test('fails a help request whose browser is closed instead of reporting a hand-back', async () => {
  // Given an agent waiting for help in a profile's browser.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory, profiles: fakeProfiles({ '/work': 'p1' }) });
  const asked = manager.requestHelp({ reason: 'Sign in', timeoutSeconds: 60 }, undefined, context('/work', 'ses_one'));
  await new Promise((resolve) => setImmediate(resolve));

  // When the profile is deleted while it waits, then the wait ends with an error at once.
  await manager.deleteProfile('p1');
  await assert.rejects(asked, /closed while waiting for help/);
  assert.equal(manager.state().help, null);
});

test('closes a chat\'s browser without saving, even one on a profile, and guards it like other dock routes', async () => {
  // Given a chat on a saved profile.
  const store = fakeProfiles({ '/work': 'p1' });
  const { factory, runtimes } = copyRuntimes(store);
  const manager = createBrowserManager({ createRuntime: factory, profiles: store });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/work', 'ses_one'));
  const scopeId = manager.state().scopes[0].id;
  const generation = manager.state().generation;

  // When a stale or leased close request arrives, then it is refused and nothing closes.
  await assert.rejects(manager.closeScope(scopeId, generation + 1), /view changed/i);
  await manager.surfaceControl('user');
  await assert.rejects(manager.closeScope(scopeId, generation), /idle/i);
  await manager.surfaceControl('none');
  assert.equal(manager.state().scopes.length, 1);

  // When the dock closes it, then the browser closes unsaved and the profile keeps its version.
  await manager.closeScope(scopeId, manager.state().generation);
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['close']);
  assert.equal(manager.state().scopes.length, 0);
  assert.equal(store.versions.get('p1'), 0);

  // An id that no longer exists is refused too.
  await assert.rejects(manager.closeScope(scopeId, manager.state().generation), /no longer exists/);
});

test('runs page/evaluate and page/capture on the visible tab, refused while the agent is mid-action', async () => {
  // Given a visible scope with an agent action in flight.
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const generation = manager.state().generation;
  const runtime = runtimes.get('ses_one');
  runtime.perform = async () => {
    runtime.agentActive = true;
    started.resolve();
    await finish.promise;
    runtime.agentActive = false;
    return {};
  };
  const action = manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  await started.promise;

  // When the dock evaluates or captures while the agent is mid-action, then it is refused at once, not queued.
  // `pageEvaluate`/`pageCapture` validate outside the operation queue (see
  // the manager), so a refusal is a synchronous throw; `assert.rejects`
  // only turns that into a rejection it can check from inside an `async`
  // wrapper, a plain arrow re-throws instead of handing it over.
  await assert.rejects(async () => manager.pageEvaluate('1+1', generation, {}), /agent is using this page/);
  await assert.rejects(async () => manager.pageCapture(generation, {}), /agent is using this page/);
  finish.resolve();
  await action;

  // When the agent is done, then both run and answer the runtime's value.
  assert.equal(await manager.pageEvaluate('1+1', manager.state().generation, {}, { userGesture: true }), 'ran:1+1');
  assert.deepEqual(runtimes.get('ses_one').calls.find(([kind]) => kind === 'evaluate'), ['evaluate', '1+1', { userGesture: true }]);
  assert.deepEqual(await manager.pageCapture(manager.state().generation, {}), { base64: 'AA==', mime: 'image/png', width: 10, height: 20 });

  // Dock access and generation are still enforced like any other dock route.
  await assert.rejects(async () => manager.pageEvaluate('1+1', manager.state().generation + 1, {}), /view changed/i);
  await manager.surfaceControl('user');
  await assert.rejects(async () => manager.pageCapture(manager.state().generation, {}), /idle/i);
});

test('sets a scope\'s zoom level, reports it in state, and clears its cookies or cache', async () => {
  // Given a visible scope.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const generation = manager.state().generation;
  assert.equal(manager.state().scopes[0].zoomLevel, 0);

  // When the dock zooms in, then the scope's runtime is told and state reflects it.
  await manager.pageZoom(2, generation, {});
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['zoom', 2]);
  assert.equal(manager.state().scopes[0].zoomLevel, 2);

  // When the dock clears cookies or cache, then the runtime is told which.
  await manager.pageClear('cookies', manager.state().generation, {});
  await manager.pageClear('cache', manager.state().generation, {});
  assert.deepEqual(runtimes.get('ses_one').calls.filter(([kind]) => kind === 'clear'), [['clear', 'cookies'], ['clear', 'cache']]);

  // Stale generations and a held surface are refused like other dock mutations.
  await assert.rejects(manager.pageZoom(1, manager.state().generation + 1, {}), /view changed/i);
  manager.surfaceControl('user');
  await assert.rejects(manager.pageClear('cookies', manager.state().generation, {}), /idle/i);
});

test('opens a chat scope for a viewer whose last frame showed a scope that has since closed', async () => {
  // Given a viewer that drew a frame of a sign-in browser, which then closed and left nothing selected.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const shown = await manager.surfaceFrame({ after: 0, wait: 0 });
  const scopeId = manager.state().selectedScopeId;
  await manager.closeScope(scopeId, manager.state().generation);
  assert.equal(manager.state().selectedScopeId, null);

  // When it opens its chat's scope carrying that old frame, then the scope opens.
  await manager.openScope({ directory: '/repo', sessionId: 'ses_two' }, manager.state().generation, { viewer: 'v1', frameSeq: shown.sequence });
  assert.notEqual(manager.state().selectedScopeId, null);
});

test('lets a viewer pick a tab right after switching chats, before it drew the new chat\'s picture', async () => {
  // Given a viewer that drew the second chat's page and then went back to the first chat.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_two'));
  await manager.openScope(context('/repo', 'ses_two'), manager.state().generation);
  const shown = await manager.surfaceFrame({ after: 0, wait: 0 });
  await manager.openScope(context('/repo', 'ses_one'), manager.state().generation, { viewer: 'v1', frameSeq: shown.sequence });

  // When it picks a tab of the first chat carrying that frame of the second, then the tab is shown.
  await manager.selectTab('tab-2', manager.state().generation, { viewer: 'v1', frameSeq: shown.sequence });
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['command', 'tab-select', { tabId: 'tab-2' }]);

  // Driving the page still waits for a picture of it.
  await assert.rejects(manager.navigate('https://one.test/next', manager.state().generation, { viewer: 'v1', frameSeq: shown.sequence }), /view changed/i);
});

test('closes a named tab even after the view moved on since the dock last looked', async () => {
  // Given a visible scope whose view changed after the dock read its generation.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const stale = manager.state().generation;
  const runtime = runtimes.get('ses_one');
  runtime.tabs = [{ id: 'tab-x', active: true }];
  const shown = await manager.surfaceFrame({ after: 0, wait: 0 });
  runtime.tabs = [{ id: 'tab-x', active: false }, { id: 'tab-y', active: true }];
  runtime.changeTabs();
  assert.notEqual(manager.state().generation, stale);

  // When the dock closes a tab by id with the old generation and an earlier frame, then it closes.
  await manager.closeTab('tab-x', stale, { viewer: 'v1', frameSeq: shown.sequence });
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['command', 'tab-close', { tabId: 'tab-x' }]);
});

test('lets the viewer pick tabs and chats while an agent holds the picture, and drive any chat but the agent\'s', async () => {
  // Given two chats, the agent working in the first one, which is visible.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.open', { url: 'https://two.test' }, undefined, context('/repo', 'ses_two'));
  await manager.perform('browser.open', { url: 'https://one.test' }, undefined, context('/repo', 'ses_one'));
  await manager.openScope(context('/repo', 'ses_one'), manager.state().generation);
  await manager.surfaceControl('agent');

  // When the viewer switches tabs there, then the tab is shown, but the page itself stays the agent's.
  await manager.selectTab('tab-2', manager.state().generation);
  assert.deepEqual(runtimes.get('ses_one').calls.at(-1), ['command', 'tab-select', { tabId: 'tab-2' }]);
  await assert.rejects(manager.navigate('https://blocked.test', manager.state().generation), /surface is idle/i);

  // When the viewer opens the other chat, then it is shown and its own page can be driven.
  await manager.openScope(context('/repo', 'ses_two'), manager.state().generation);
  assert.equal(manager.state().scopes.find((scope) => scope.selected)?.sessionId, 'ses_two');
  await manager.navigate('https://free.test', manager.state().generation);
  assert.equal(runtimes.get('ses_two').url, 'https://free.test');
});

test('switches to an open chat\'s browser without waiting behind a running agent action', { timeout: 2_000 }, async () => {
  // Given an agent action that never finishes in one chat, and another chat's browser already open.
  const { factory } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: (scope, profile) => {
    const runtime = factory(scope, profile);
    if (scope.sessionId === 'ses_busy') runtime.perform = () => new Promise(() => {});
    return runtime;
  } });
  await manager.openScope(context('/repo', 'ses_idle'), manager.state().generation);
  await manager.openScope(context('/repo', 'ses_busy'), manager.state().generation);
  void manager.perform('browser.open', { url: 'https://slow.test' }, undefined, context('/repo', 'ses_busy'));

  // When the viewer goes back to the idle chat, then it is shown at once.
  await manager.openScope(context('/repo', 'ses_idle'), manager.state().generation);
  assert.equal(manager.state().scopes.find((scope) => scope.selected)?.sessionId, 'ses_idle');
});

test('reports each chat\'s agent tab and whether an action runs there', async () => {
  // Given a chat whose agent works in its second tab.
  const { factory, runtimes } = createRuntimeFactory();
  const manager = createBrowserManager({ createRuntime: factory });
  await manager.perform('browser.snapshot', {}, undefined, context('/repo', 'ses_one'));
  const runtime = runtimes.get('ses_one');
  runtime.agentTabId = 'tab-2';

  // Then the state names that tab, idle; while an action runs it is reported active.
  assert.equal(manager.state().scopes[0].agentTabId, 'tab-2');
  assert.equal(manager.state().scopes[0].agentActive, false);
  runtime.agentActive = true;
  assert.equal(manager.state().scopes[0].agentActive, true);
});
