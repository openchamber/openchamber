import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import type { GitNetworkOperation, GitNetworkOperationPlan } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitOperationRecovery } from './useGitOperationRecovery';
import { createGitOperationRecoveryOwner } from '@/lib/source-control/git-operation-recovery';

type Recovery = ReturnType<typeof useGitOperationRecovery>;

const plan: GitNetworkOperationPlan = {
  state: 'planned', operationId: 'git_original', runtimeIdentity: { id: 'server-a', platform: 'web' },
  target: { operation: 'push', repositoryId: 'repo-a', bindingRevision: 1, configRevision: 'config-a',
    remote: { name: 'origin', endpoint: { displayUrl: 'https://example.com/repo.git', fingerprint: 'endpoint' } },
    sourceRef: 'refs/heads/main', destinationRef: 'refs/heads/main',
  },
  transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } }, completedSteps: [],
};
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const mount = async (saved = new Map<string, string>(), existingOwner?: ReturnType<typeof createGitOperationRecoveryOwner>, initial: { offline?: boolean; operation?: GitNetworkOperation } = {}) => {
  let failWrite = false;
  const owner = existingOwner ?? createGitOperationRecoveryOwner(() => ({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { if (failWrite) throw new Error('storage denied'); saved.set(key, value); },
  }));
  class TestWindow extends EventTarget {
    HTMLIFrameElement = class {};
    __OPENCHAMBER_API_BASE_URL__ = 'https://runtime-a.example.com';
  }
  const runtimeWindow = new TestWindow();
  const document = Object.assign(new EventTarget(), { nodeType: 9, defaultView: runtimeWindow, activeElement: null });
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml' });
  Object.defineProperty(container, 'ownerDocument', { value: document });
  const globals: Array<[string, PropertyDescriptor]> = [
    ['window', { value: runtimeWindow, configurable: true }], ['document', { value: document, configurable: true }],
    ['IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true }],
  ];
  const previous = globals.map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, descriptor] of globals) Object.defineProperty(globalThis, key, descriptor);
  // SAFETY: The probe renders null; this root implements the DOM members React uses for setup and events.
  const root = createRoot(container as Element);
  let recovery: Recovery | undefined;
  let directory = '/repo';
  let repositoryId = 'repo-a';
  let operation: GitNetworkOperation = initial.operation ?? plan;
  let offline = initial.offline ?? false;
  const calls: string[] = [];
  const git = {
    getNetworkOperation: async (id: string) => { calls.push(`get:${id}`); if (offline) throw new TypeError('offline'); return operation; },
    cancelNetworkOperation: async (id: string): Promise<GitNetworkOperation> => {
      calls.push(`cancel:${id}`);
      operation = { ...plan, state: 'cancelled', error: { code: 'CANCELLED', message: 'Cancelled' } };
      return operation;
    },
  };
  const sourceControl: Parameters<typeof useGitOperationRecovery>[2] = {
    repositoryBinding: async (directory) => {
      calls.push(`repository:${directory}`);
      return { status: 'missing', revision: 0, binding: null, repository: { repositoryId, configRevision: 'config-a', bare: false, remotes: [] } };
    },
  };
  const Probe = () => { recovery = useGitOperationRecovery(directory, git, sourceControl, { owner }); return null; };
  const render = () => act(() => { root.render(React.createElement(Probe)); });
  render();
  const settle = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      if (recovery?.entry?.problem !== 'reconciling' && !recovery?.entry?.checking) return;
    }
    throw new Error('Recovery did not settle');
  };
  await settle();
  const initialCalls = [...calls];
  calls.length = 0;
  let mounted = true;
  const unmount = () => { if (mounted) { act(() => root.unmount()); mounted = false; } };
  cleanups.push(() => {
    unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    get recovery() { if (!recovery) throw new Error('Probe did not render'); return recovery; },
    start: () => {
      const result = React.createRef<ReturnType<Recovery['start']>>();
      act(() => { if (recovery) result.current = recovery.start(); });
      if (!result.current) throw new Error('Expected an action');
      return result.current;
    },
    calls,
    owner, saved, unmount, settle, initialCalls,
    setStorageFailure: (failed: boolean) => { failWrite = failed; },
    setOperation: (next: GitNetworkOperation) => { operation = next; },
    setOffline: (next: boolean) => { offline = next; },
    setRepository: (next: string) => { repositoryId = next; },
    setDirectory: async (next: string) => { directory = next; render(); await settle(); calls.length = 0; },
    setRuntime: async (next: string) => {
      act(() => {
        runtimeWindow.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
        runtimeWindow.__OPENCHAMBER_API_BASE_URL__ = next;
        runtimeWindow.dispatchEvent(new Event('openchamber:runtime-endpoint-changed'));
      });
      await settle();
      calls.length = 0;
    },
    online: () => act(async () => { runtimeWindow.dispatchEvent(new Event('online')); }),
  };
};

// `subtle` is a non-configurable getter on the Crypto prototype under Bun, so the
// property cannot be shadowed. Stand in for the whole global instead, keeping the
// random generators the rest of the suite may reach for.
const withoutSubtle = async <T>(run: () => Promise<T>): Promise<T> => {
  const real = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const stub = {
    getRandomValues: <A extends ArrayBufferView>(array: A): A => real.getRandomValues(array),
    randomUUID: () => real.randomUUID(),
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: stub });
  try {
    // Fail loudly rather than let the fallback silently stop being covered.
    if (globalThis.crypto?.subtle) throw new Error('SubtleCrypto is still reachable');
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
};

describe('mounted Git action recovery', () => {
  test('missing SubtleCrypto does not show a storage failure or block the Git UI', async () => {
    await withoutSubtle(async () => {
      const fixture = await mount();
      expect(fixture.recovery.blocked).toBe(false);
      expect(fixture.recovery.entry?.problem ?? null).toBeNull();
      const action = fixture.start();
      act(() => { action.finish(); });
      fixture.setStorageFailure(true);
      act(() => { expect(fixture.recovery.start()).toBeNull(); });
      expect(fixture.recovery.entry?.problem).toBe('storage');
    });
  });
  test('unmount, remount and reload preserve uncertainty until GET proves a terminal result', async () => {
    const first = await mount();
    const handle = first.start();
    first.setOperation({ ...plan, state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Unknown' } });
    await act(async () => { await first.owner.remember(getRuntimeKey(), plan); });
    act(() => {
      handle.onOperation({ runtimeKey: getRuntimeKey(), operation: { ...plan, state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Unknown' } }, availability: 'available' });
      handle.finish();
    });
    await first.settle();
    first.unmount();
    const reopened = await mount(first.saved, first.owner, { offline: true });
    expect(reopened.recovery.blocked).toBe(true);
    expect(reopened.recovery.entry?.pending?.[0].operationId).toBe(plan.operationId);
    expect(reopened.recovery.entry?.reads).toEqual([]);
    expect(reopened.initialCalls.filter((call) => call.startsWith('get:'))).toEqual(['get:git_original']);
    expect(reopened.recovery.start()).toBeNull();
    reopened.unmount();
    const reloaded = await mount(first.saved, undefined, { offline: true });
    expect(reloaded.recovery.blocked).toBe(true);
    expect(reloaded.recovery.entry?.reads).toEqual([]);
    expect(reloaded.initialCalls.filter((call) => call.startsWith('get:'))).toEqual(['get:git_original']);
    reloaded.setOffline(false);
    reloaded.setOperation({ ...plan, state: 'succeeded' });
    await act(async () => { await reloaded.recovery.refresh(); });
    expect(reloaded.recovery.blocked).toBe(false);
    expect(reloaded.owner.getSnapshot().references).toEqual([]);
    expect(reloaded.recovery.entry?.reads[0].operation.state).toBe('succeeded');
  });

  test('storage failure refuses a new UI action before local or network mutation', async () => {
    const fixture = await mount();
    fixture.setStorageFailure(true);
    act(() => { expect(fixture.recovery.start()).toBeNull(); });
    expect(fixture.recovery.blocked).toBe(true);
    expect(fixture.recovery.entry?.problem).toBe('storage');
    expect(fixture.calls).toEqual([]);
  });

  test('a user can start another operation only after a known terminal result', async () => {
    const fixture = await mount();
    const runtimeKey = getRuntimeKey();
    const handle = fixture.start();
    act(() => {
      handle.onOperation({ runtimeKey, operation: plan, availability: 'available' });
      handle.commitCreated();
      handle.finish();
    });
    expect(fixture.recovery.blocked).toBe(true);
    expect(fixture.recovery.start()).toBeNull();
    fixture.setOffline(true);
    await act(async () => { await fixture.recovery.refresh(); });
    expect(fixture.recovery.entry?.reads[0].availability).toBe('unavailable');
    expect(fixture.recovery.entry?.localCommit).toBe(true);
    expect(fixture.recovery.start()).toBeNull();
    fixture.setOffline(false);
    fixture.setOperation({ ...plan, state: 'failed', completedSteps: ['validated', 'transferred'], error: { code: 'TRANSPORT_FAILED', message: 'Rejected' } });
    await act(async () => { await fixture.recovery.refresh(); });
    expect(fixture.recovery.blocked).toBe(false);
    expect(fixture.recovery.entry?.localCommit).toBe(true);
    expect(fixture.recovery.entry?.reads[0].operation.completedSteps).toEqual(['validated', 'transferred']);
    expect(fixture.calls).toEqual(['repository:/repo', 'get:git_original', 'repository:/repo', 'get:git_original']);
    act(() => { expect(fixture.recovery.start()).not.toBeNull(); });
    expect(fixture.recovery.entry?.reads).toEqual([]);
  });

  test('Cancel is available while execute is pending and a late execute cannot regress its result', async () => {
    const fixture = await mount();
    const handle = fixture.start();
    act(() => { handle.onOperation({ runtimeKey: getRuntimeKey(), operation: plan, availability: 'available' }); });
    await act(async () => { await fixture.recovery.cancel(); });
    expect(fixture.calls).toEqual(['repository:/repo', 'get:git_original', 'cancel:git_original']);
    expect(fixture.recovery.entry?.reads[0].operation.state).toBe('cancelled');
    act(() => { handle.onOperation({ runtimeKey: getRuntimeKey(), operation: plan, availability: 'unavailable' }); handle.finish(); });
    expect(fixture.recovery.entry?.reads[0].operation.state).toBe('cancelled');
    expect(fixture.recovery.blocked).toBe(false);
  });

  test('Refresh and Cancel stay scoped across directory, runtime and repository changes', async () => {
    const fixture = await mount();
    const handle = fixture.start();
    act(() => { handle.onOperation({ runtimeKey: getRuntimeKey(), operation: plan, availability: 'available' }); handle.finish(); });
    const oldControls = fixture.recovery;
    await fixture.setDirectory('/other');
    await oldControls.cancel();
    await fixture.recovery.refresh();
    expect(fixture.calls).toEqual([]);
    expect(fixture.recovery.entry).toBe(undefined);
    await fixture.setDirectory('/repo');
    await fixture.setRuntime('https://runtime-b.example.com');
    await oldControls.cancel();
    expect(fixture.calls).toEqual([]);
    expect(fixture.recovery.entry).toBe(undefined);
    await fixture.setRuntime('https://runtime-a.example.com');
    expect(fixture.recovery.entry?.reads[0].operation.operationId).toBe('git_original');
    fixture.setRepository('replacement-repo');
    await act(async () => { await fixture.recovery.cancel(); });
    expect(fixture.calls).toEqual(['repository:/repo']);
    expect(fixture.recovery.entry?.reads[0].availability).toBe('unavailable');
  });

  test('reconnect does one GET, retains unknown outcomes, and never starts a new operation', async () => {
    const fixture = await mount();
    const handle = fixture.start();
    act(() => { handle.onOperation({ runtimeKey: getRuntimeKey(), operation: plan, availability: 'unavailable' }); handle.finish(); });
    fixture.setOperation({ ...plan, state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Unknown' } });
    await fixture.online();
    expect(fixture.calls).toEqual(['repository:/repo', 'get:git_original']);
    expect(fixture.recovery.blocked).toBe(true);
    expect(fixture.recovery.start()).toBeNull();
  });
});
