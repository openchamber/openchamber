import { describe, expect, test } from 'bun:test';

import { ChildStoreManager } from '@/sync/child-store';

import {
  createActiveSessionBlockingRequestRevalidator,
} from './useActiveSessionBootstrapDemand';

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

class TestEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

async function createCompleteManager(directory = '/work/app') {
  const manager = new ChildStoreManager();
  const cleanup = manager.configure({
    onBootstrap: async ({ directory: targetDirectory }) => {
      manager.getChild(targetDirectory)?.setState({ status: 'complete' });
    },
  });
  manager.requestBootstrap({ directory, priority: 'selected', reason: 'selected-session' });
  await settle();
  expect(manager.getBootstrapState(directory)).toBe('complete');
  return { manager, cleanup };
}

describe('active-session blocking-request revalidation', () => {
  test('revalidates a selected session immediately when directory bootstrap is complete', async () => {
    const { manager, cleanup } = await createCompleteManager();
    const calls: Array<{ directory: string; sessionId: string }> = [];

    const dispose = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app/',
      sessionId: 'ses_a',
      resync: async (directory, _store, candidateSessionIds) => {
        calls.push({ directory, sessionId: candidateSessionIds[0] });
      },
    });
    await settle();

    expect(calls).toEqual([{ directory: '/work/app', sessionId: 'ses_a' }]);

    dispose();
    cleanup();
    manager.disposeAll();
  });

  test('waits for bootstrap completion before the exact active selection revalidates', async () => {
    const manager = new ChildStoreManager();
    let finishBootstrap: (() => void) | undefined;
    const bootstrapGate = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    const calls: string[] = [];
    const cleanup = manager.configure({
      onBootstrap: async ({ directory }) => {
        await bootstrapGate;
        manager.getChild(directory)?.setState({ status: 'complete' });
      },
    });
    manager.requestBootstrap({ directory: '/work/app', priority: 'selected', reason: 'selected-session' });

    const dispose = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app',
      sessionId: 'ses_a',
      resync: async (_directory, _store, candidateSessionIds) => {
        calls.push(candidateSessionIds[0]);
      },
    });
    await settle();
    expect(calls).toEqual([]);

    finishBootstrap?.();
    await settle();
    await settle();
    expect(calls).toEqual(['ses_a']);

    dispose();
    cleanup();
    manager.disposeAll();
  });

  test('uses the same revalidation path when the active surface returns', async () => {
    const { manager, cleanup } = await createCompleteManager();
    const documentTarget = Object.assign(new TestEventTarget(), { visibilityState: 'hidden' });
    const windowTarget = new TestEventTarget();
    const calls: string[] = [];

    const dispose = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app',
      sessionId: 'ses_a',
      documentTarget,
      windowTarget,
      resync: async () => {
        calls.push('resync');
      },
    });
    await settle();
    expect(calls).toHaveLength(1);

    documentTarget.dispatch('visibilitychange');
    await settle();
    expect(calls).toHaveLength(1);

    documentTarget.visibilityState = 'visible';
    documentTarget.dispatch('visibilitychange');
    await settle();
    windowTarget.dispatch('focus');
    await settle();
    windowTarget.dispatch('pageshow');
    await settle();
    expect(calls).toHaveLength(4);

    dispose();
    windowTarget.dispatch('focus');
    await settle();
    expect(calls).toHaveLength(4);

    cleanup();
    manager.disposeAll();
  });

  test('coalesces duplicate in-flight triggers without suppressing another selected session', async () => {
    const { manager, cleanup } = await createCompleteManager();
    const windowTarget = new TestEventTarget();
    const calls: string[] = [];
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const resync = async (_directory: string, _store: unknown, candidateSessionIds: string[]) => {
      calls.push(candidateSessionIds[0]);
      if (candidateSessionIds[0] === 'ses_a' && calls.filter((id) => id === 'ses_a').length === 1) {
        await firstGate;
      }
    };

    const disposeA = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app',
      sessionId: 'ses_a',
      windowTarget,
      resync,
    });
    await settle();
    windowTarget.dispatch('focus');
    windowTarget.dispatch('pageshow');
    await settle();
    expect(calls).toEqual(['ses_a']);

    const disposeB = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app',
      sessionId: 'ses_b',
      resync,
    });
    await settle();
    expect(calls).toEqual(['ses_a', 'ses_b']);

    finishFirst?.();
    await settle();
    windowTarget.dispatch('focus');
    await settle();
    expect(calls).toEqual(['ses_a', 'ses_b', 'ses_a']);

    disposeA();
    disposeB();
    cleanup();
    manager.disposeAll();
  });

  test('selection cleanup prevents a waiting stale selection from launching', async () => {
    const manager = new ChildStoreManager();
    let finishBootstrap: (() => void) | undefined;
    const bootstrapGate = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    const calls: string[] = [];
    const cleanup = manager.configure({
      onBootstrap: async ({ directory }) => {
        await bootstrapGate;
        manager.getChild(directory)?.setState({ status: 'complete' });
      },
    });
    manager.requestBootstrap({ directory: '/work/app', priority: 'selected', reason: 'selected-session' });
    const resync = async (_directory: string, _store: unknown, candidateSessionIds: string[]) => {
      calls.push(candidateSessionIds[0]);
    };

    const disposeA = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app',
      sessionId: 'ses_a',
      resync,
    });
    disposeA();
    const disposeB = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: '/work/app',
      sessionId: 'ses_b',
      resync,
    });

    finishBootstrap?.();
    await settle();
    await settle();
    expect(calls).toEqual(['ses_b']);

    disposeB();
    cleanup();
    manager.disposeAll();
  });
});
