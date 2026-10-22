import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session, ToolPart } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { ChildStoreManager, markDirectorySessionPartChanged } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { applyGlobalSessionStatusEvent, applyGlobalSessionStatusSnapshot, replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { applyGlobalBlockingRequestEvents, applyWaitingPageEvent, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { hasMobileScreenAwakeWork, subscribeMobileScreenAwake } from './mobileScreenAwake';

const parents = new Map([['child', 'root'], ['grandchild', 'child'], ['sibling', 'root']]);
const parentOf = (id: string) => parents.get(id);
const noWaits = () => [];
const dependencies = new Map([['root', ['child']], ['child', ['grandchild']]]);
const waitsFor = (id: string) => dependencies.get(id) ?? [];
const session = (id: string, parentID?: string): Session => ({
  id, parentID, directory: '/awake', projectID: 'project', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

describe('screen-awake work scope', () => {
  test('uses only live work in the open session tree', () => {
    expect(hasMobileScreenAwakeWork(null, new Set(['root']), [], parentOf, noWaits)).toBe(false);
    expect(hasMobileScreenAwakeWork('root', new Set(), [], parentOf, noWaits)).toBe(false);
    expect(hasMobileScreenAwakeWork('root', new Set(['unrelated']), [], parentOf, noWaits)).toBe(false);
    expect(hasMobileScreenAwakeWork('root', new Set(['root']), [], parentOf, noWaits)).toBe(true);
    expect(hasMobileScreenAwakeWork('root', new Set(['grandchild']), [], parentOf, noWaits)).toBe(true);
  });

  test('a blocked subagent releases its waiting ancestors but not a working sibling', () => {
    expect(hasMobileScreenAwakeWork('root', new Set(['root', 'child', 'grandchild']), ['grandchild'], parentOf, waitsFor)).toBe(false);
    expect(hasMobileScreenAwakeWork('root', new Set(['root', 'child', 'sibling']), ['child'], parentOf, waitsFor)).toBe(true);
    expect(hasMobileScreenAwakeWork('root', new Set(['root', 'child']), ['root'], parentOf, waitsFor)).toBe(true);
    expect(hasMobileScreenAwakeWork('root', new Set(['root']), ['unrelated'], parentOf, waitsFor)).toBe(true);
  });

  test('a blocked background child never excludes an independently working parent', () => {
    expect(hasMobileScreenAwakeWork('root', new Set(['root', 'child']), ['child'], parentOf, noWaits)).toBe(true);
    expect(hasMobileScreenAwakeWork('root', new Set(['root', 'child', 'sibling']), ['child'], parentOf,
      (id) => id === 'root' ? ['child', 'sibling'] : [])).toBe(true);
  });

  test('malformed parent cycles are bounded', () => {
    const cycle = new Map([['a', 'b'], ['b', 'a']]);
    expect(hasMobileScreenAwakeWork('root', new Set(['a']), ['b'], (id) => cycle.get(id), noWaits)).toBe(false);
  });
});

describe('mobile screen-awake lifecycle', () => {
  let windowInstance: Window;
  let restoreGlobals: () => void;
  let controller: ReturnType<typeof subscribeMobileScreenAwake>;
  let calls: boolean[];
  let errors: number;
  let childStores: ChildStoreManager;

  beforeEach(() => {
    windowInstance = new Window({ url: 'https://screen-awake.test' });
    const names = ['window', 'document'];
    const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    Object.assign(globalThis, { window: windowInstance, document: windowInstance.document });
    Object.defineProperty(windowInstance, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://screen-awake.test', configurable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    useUIStore.getState().setMobileScreenAwakeMode('off');
    useConfigStore.setState({ isConnected: true });
    useSessionUIStore.setState({ currentSessionId: 'root' });
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    childStores = new ChildStoreManager();
    childStores.ensureChild('/awake', { bootstrap: false });
    setSyncRefs(opencodeClient.getSdkClient(), childStores, '/awake');
    useGlobalSessionsStore.getState().applySnapshot([session('root'), session('child', 'root'), session('other')], []);
    calls = [];
    errors = 0;
    controller = subscribeMobileScreenAwake(async (enabled) => { calls.push(enabled); }, () => { errors += 1; });
  });

  afterEach(() => {
    controller.dispose();
    useUIStore.getState().setMobileScreenAwakeMode('off');
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    childStores.disposeAll();
    windowInstance.close();
    restoreGlobals();
  });

  const busy = (id: string) => applyGlobalSessionStatusEvent('/awake', {
    type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } },
  });
  const idle = (id: string) => applyGlobalSessionStatusEvent('/awake', {
    type: 'session.idle', properties: { sessionID: id },
  });
  const subagentCall = (): ToolPart => ({
    id: 'call-child', callID: 'call-child', sessionID: 'root', messageID: 'step', type: 'tool', tool: 'subagent',
    state: { status: 'running', input: {}, metadata: { sessionID: 'child' }, time: { start: 2 } },
  });
  const parentStep = (parts: ToolPart[]) => childStores.getChild('/awake')?.setState({
    message: { root: [{ id: 'step', role: 'assistant', sessionID: 'root', agent: 'build', providerID: 'p', modelID: 'm', time: { created: 1, streamed: 2 } }] },
    part: { step: parts },
  });

  test('Off ignores work; Always works without a session or connection and respects lifecycle', () => {
    busy('root');
    expect(calls).toEqual([false]);
    useConfigStore.setState({ isConnected: false });
    useSessionUIStore.setState({ currentSessionId: null });
    useUIStore.getState().setMobileScreenAwakeMode('always');
    controller.setForeground(false);
    controller.setForeground(true);
    useUIStore.getState().setMobileScreenAwakeMode('off');
    expect(calls).toEqual([false, true, false, true, false]);
  });

  test('tracks current work, retries, child work, navigation and connection changes', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('other');
    expect(calls).toEqual([false]);
    busy('child');
    expect(calls).toEqual([false, true]);
    useSessionUIStore.setState({ currentSessionId: 'other' });
    idle('other');
    expect(calls).toEqual([false, true, false]);
    useSessionUIStore.setState({ currentSessionId: 'root' });
    useConfigStore.setState({ isConnected: false });
    useConfigStore.setState({ isConnected: true });
    expect(calls.at(-1)).toBe(false);
    applyGlobalSessionStatusEvent('/awake', { type: 'session.status', properties: { sessionID: 'child', status: { type: 'retry', attempt: 1, message: 'Retry', next: 0 } } });
    idle('child');
    expect(calls).toEqual([false, true, false, true, false, true, false]);
  });

  test('reconnect waits for fresh activity even when the next busy event is unchanged', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('child');
    useConfigStore.setState({ isConnected: false });
    useConfigStore.setState({ isConnected: true });
    useSessionUIStore.setState({ currentSessionId: 'other' });
    useSessionUIStore.setState({ currentSessionId: 'root' });
    controller.setForeground(true);
    expect(calls).toEqual([false, true, false]);
    busy('child');
    expect(calls).toEqual([false, true, false, true]);
  });

  test('an unchanged authoritative snapshot restores retention after reconnect', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('child');
    useConfigStore.setState({ isConnected: false });
    busy('other');
    useConfigStore.setState({ isConnected: true });
    applyGlobalSessionStatusSnapshot('/awake', { child: { type: 'busy' }, other: { type: 'busy' } });
    expect(calls).toEqual([false, true, false, true]);
    applyGlobalSessionStatusSnapshot('/awake', {});
    expect(calls.at(-1)).toBe(false);
  });

  test('disconnect while Off cannot be hidden by turning working mode on later', () => {
    busy('child');
    useConfigStore.setState({ isConnected: false });
    useConfigStore.setState({ isConnected: true });
    useUIStore.getState().setMobileScreenAwakeMode('working');
    expect(calls).toEqual([false]);
    busy('child');
    useUIStore.getState().setMobileScreenAwakeMode('off');
    idle('child');
    useUIStore.getState().setMobileScreenAwakeMode('working');
    expect(calls).toEqual([false, true, false]);
  });

  test('permissions, forms and waiting pages release the screen until answered', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('root');
    busy('child');
    parentStep([subagentCall()]);
    applyGlobalBlockingRequestEvents('/awake', [{ type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', action: 'bash', resources: ['echo test'] } }]);
    expect(calls.at(-1)).toBe(false);
    applyGlobalBlockingRequestEvents('/awake', [{ type: 'permission.replied', properties: { sessionID: 'child', requestID: 'p1' } }]);
    expect(calls.at(-1)).toBe(true);
    applyGlobalBlockingRequestEvents('/awake', [{ type: 'form.created', properties: { form: { id: 'f1', sessionID: 'child', title: 'Choose', fields: [{ key: 'answer', type: 'boolean' }] } } }]);
    expect(calls.at(-1)).toBe(false);
    applyGlobalBlockingRequestEvents('/awake', [{ type: 'form.settled', properties: { sessionID: 'child', formID: 'f1' } }]);
    applyWaitingPageEvent({ type: 'openchamber.page-waiting', properties: { sessionID: 'child', directory: '/awake', page: { id: 'page1', title: 'Pick' } } }, () => '/awake');
    expect(calls.at(-1)).toBe(false);
    applyWaitingPageEvent({ type: 'openchamber.page-settled', properties: { sessionID: 'child', pageID: 'page1' } }, () => '/awake');
    expect(calls.at(-1)).toBe(true);
  });

  test('retains independent parent work and reacts when it starts or stops waiting for the child', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('root');
    busy('child');
    applyGlobalBlockingRequestEvents('/awake', [{ type: 'permission.asked', properties: { id: 'p1', sessionID: 'child', action: 'shell', resources: ['test'] } }]);
    expect(calls).toEqual([false, true]);
    const call = subagentCall();
    parentStep([call]);
    expect(calls.at(-1)).toBe(false);
    parentStep([call, { ...call, id: 'independent', callID: 'independent', tool: 'read' }]);
    expect(calls.at(-1)).toBe(true);
    parentStep([{ ...call, state: { status: 'completed', input: {}, output: '', metadata: { sessionID: 'child', status: 'running' }, time: { start: 2, end: 3 } } }]);
    expect(calls.at(-1)).toBe(true);
    parentStep([call]);
    expect(calls.at(-1)).toBe(false);
    applyGlobalSessionStatusEvent('/awake', { type: 'session.status', properties: { sessionID: 'root', status: { type: 'retry', attempt: 1, message: 'Retry', next: 0 } } });
    // Retry membership is unchanged, so the dependency subscriber also observes status type changes.
    expect(calls.at(-1)).toBe(true);
  });

  test('streamed token deltas do not re-evaluate or write native state', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('root');
    const store = childStores.getChild('/awake');
    if (!store) throw new Error('Missing test directory');
    for (let i = 0; i < 1000; i += 1) {
      markDirectorySessionPartChanged(store, 'root', 'step', false);
      store.setState({ part: { step: [{ id: 'text', sessionID: 'root', messageID: 'step', type: 'text', text: String(i) }] } });
    }
    expect(calls).toEqual([false, true]);
  });

  test('1000 repeated status and metadata updates add no native writes', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('child');
    const structure = useGlobalSessionsStore.getState().structure;
    for (let i = 0; i < 1000; i += 1) {
      busy('child');
      useGlobalSessionsStore.getState().upsertSession({ ...session('child', 'root'), title: `Child ${i}` });
    }
    expect(useGlobalSessionsStore.getState().structure).toBe(structure);
    expect(calls).toEqual([false, true]);
  });

  test('foreground transitions release and restore work without preserving it after completion', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('child');
    controller.setForeground(false);
    idle('child');
    controller.setForeground(true);
    expect(calls).toEqual([false, true, false]);
    busy('root');
    applyGlobalSessionStatusEvent('/awake', { type: 'session.error', properties: { sessionID: 'root', error: { type: 'Interrupted', message: 'Stopped' } } });
    expect(calls.at(-1)).toBe(false);
  });

  test('an unanswered request in an unrelated chat cannot block current work', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('root');
    applyGlobalBlockingRequestEvents('/awake', [{ type: 'permission.asked', properties: { id: 'other-permission', sessionID: 'other', action: 'bash', resources: ['echo test'] } }]);
    expect(calls).toEqual([false, true]);
  });

  test('reports a current native failure but ignores obsolete enable failures', async () => {
    controller.dispose();
    controller = subscribeMobileScreenAwake(async (enabled) => {
      if (enabled) {
        await Promise.resolve();
        throw new Error('Stale native enable failed');
      }
    }, () => { errors += 1; });
    useUIStore.getState().setMobileScreenAwakeMode('always');
    useUIStore.getState().setMobileScreenAwakeMode('off');
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toBe(0);
    controller.dispose();
    controller = subscribeMobileScreenAwake(async (enabled) => {
      if (enabled) throw new Error('Native enable failed');
    }, () => { errors += 1; });
    useUIStore.getState().setMobileScreenAwakeMode('always');
    await Promise.resolve();
    expect(errors).toBe(1);
  });

  test('a failed native value is retried on the next foreground reconciliation', async () => {
    controller.dispose();
    let failed = false;
    controller = subscribeMobileScreenAwake(async (enabled) => {
      calls.push(enabled);
      if (enabled && !failed) {
        failed = true;
        throw new Error('Native enable failed');
      }
    }, () => { errors += 1; });
    useUIStore.getState().setMobileScreenAwakeMode('always');
    await Promise.resolve();
    controller.setForeground(true);
    expect(calls.slice(-2)).toEqual([true, true]);
    expect(errors).toBe(1);
  });

  test('runtime switches and disposal release work-based retention', () => {
    useUIStore.getState().setMobileScreenAwakeMode('working');
    busy('child');
    windowInstance.dispatchEvent(new windowInstance.CustomEvent('openchamber:runtime-endpoint-will-change'));
    expect(calls.at(-1)).toBe(false);
    controller.setForeground(true);
    expect(calls.at(-1)).toBe(false);
    busy('child');
    expect(calls.at(-1)).toBe(true);
    controller.dispose();
    const count = calls.length;
    busy('root');
    useUIStore.getState().setMobileScreenAwakeMode('always');
    controller.setForeground(true);
    expect(calls.length).toBe(count);
    expect(errors).toBe(0);
  });
});
