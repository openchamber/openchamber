import { describe, expect, test } from 'bun:test';

import {
  ChildStoreManager,
  type DirectoryBootstrapContext,
  markDirectorySessionPartChanged,
  subscribeDirectoryPermission,
  subscribeDirectoryQuestion,
  subscribeDirectoryQuestions,
  subscribeDirectorySessionMessages,
} from './child-store';
import {
  getSyncPerformanceDiagnostics,
  setSyncPerformanceDiagnosticsEnabled,
} from './performance-diagnostics';
import { DIR_IDLE_TTL_MS } from './types';
import { FilesystemError } from '@/lib/api/files-errors';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ChildStoreManager.subscribeAllSelected', () => {
  test('ignores unrelated child-store updates', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    let notifications = 0;
    const unsubscribe = manager.subscribeAllSelected((state) => state.session, () => {
      notifications += 1;
    });

    child.setState({ session_status: { session: { type: 'busy' } } });
    expect(notifications).toBe(0);

    child.setState({ session: [...child.getState().session] });
    expect(notifications).toBe(1);

    unsubscribe();
    manager.disposeAll();
  });

  test('notifies when the child-store registry changes', () => {
    const manager = new ChildStoreManager();
    let notifications = 0;
    const unsubscribe = manager.subscribeAllSelected((state) => state.session, () => {
      notifications += 1;
    });

    manager.ensureChild('/workspace', { bootstrap: false });
    expect(notifications).toBe(1);

    unsubscribe();
    manager.disposeAll();
  });

});

describe('ChildStoreManager directory lifecycle', () => {
  test('keeps an idle directory alive until its final consumer releases it', () => {
    const manager = new ChildStoreManager();
    const now = 10_000;
    const originalDateNow = Date.now;
    let currentTime = now;
    Date.now = () => currentTime;

    try {
      const child = manager.ensureChild('/workspace', { bootstrap: false });
      manager.pin('/workspace/');
      manager.pin('/workspace');
      manager.unpin('/workspace');
      currentTime = now + DIR_IDLE_TTL_MS + 1;

      manager.runEviction();

      expect(manager.pinned('/workspace')).toBe(true);
      expect(manager.getChild('/workspace')).toBe(child);

      manager.unpin('/workspace/');

      expect(manager.pinned('/workspace')).toBe(false);
      expect(manager.getChild('/workspace')).toBe(undefined);
    } finally {
      Date.now = originalDateNow;
      manager.disposeAll();
    }
  });
});

describe('ChildStoreManager permission subscriptions', () => {
  test('does not notify session permission listeners for unrelated high-frequency updates', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    let notifications = 0;
    const unsubscribers = Array.from({ length: 50 }, (_, index) => (
      subscribeDirectoryPermission(child, `session-${index}`, () => {
        notifications += 1;
      })
    ));
    setSyncPerformanceDiagnosticsEnabled(true);

    for (let index = 0; index < 10_000; index += 1) {
      child.setState({ part: { [`message-${index}`]: [] } });
    }

    expect(notifications).toBe(0);
    expect(getSyncPerformanceDiagnostics()?.permissionChangeCallbacks).toBe(0);

    child.setState({ permission: { 'session-17': [{ id: 'permission-1' }] as never[] } });

    expect(notifications).toBe(1);
    expect(getSyncPerformanceDiagnostics()?.permissionChangeCallbacks).toBe(1);
    for (const unsubscribe of unsubscribers) unsubscribe();
    setSyncPerformanceDiagnosticsEnabled(false);
    manager.disposeAll();
  });
});

describe('ChildStoreManager question subscriptions', () => {
  test('notifies only the owning session and ignores unrelated high-frequency updates', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    const notifications = new Map<string, number>();
    const unsubscribers = Array.from({ length: 50 }, (_, index) => {
      const sessionID = `session-${index}`;
      return subscribeDirectoryQuestion(child, sessionID, () => {
        notifications.set(sessionID, (notifications.get(sessionID) ?? 0) + 1);
      });
    });
    setSyncPerformanceDiagnosticsEnabled(true);

    for (let index = 0; index < 10_000; index += 1) {
      child.setState({ part: { [`message-${index}`]: [] } });
    }

    expect(notifications.size).toBe(0);
    expect(getSyncPerformanceDiagnostics()?.questionChangeCallbacks).toBe(0);

    child.setState({ question: { 'session-17': [{ id: 'question-1' }] as never[] } });

    expect(notifications.get('session-17')).toBe(1);
    expect(notifications.size).toBe(1);
    expect(getSyncPerformanceDiagnostics()?.questionChangeCallbacks).toBe(1);

    // A new map that preserves session-17's bucket must not notify it again.
    child.setState({ question: { ...child.getState().question, 'session-18': [{ id: 'question-2' }] as never[] } });

    expect(notifications.get('session-17')).toBe(1);
    expect(notifications.get('session-18')).toBe(1);
    expect(getSyncPerformanceDiagnostics()?.questionChangeCallbacks).toBe(2);

    child.setState({ question: {} });

    expect(notifications.get('session-17')).toBe(2);
    expect(notifications.get('session-18')).toBe(2);
    expect(getSyncPerformanceDiagnostics()?.questionChangeCallbacks).toBe(4);

    for (const unsubscribe of unsubscribers) unsubscribe();
    setSyncPerformanceDiagnosticsEnabled(false);
    manager.disposeAll();
  });

  test('notifies subtree and exact-session rows once for each relevant replacement', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    let parentNotifications = 0;
    let childNotifications = 0;
    const unsubscribeParent = subscribeDirectoryQuestions(child, ['parent', 'child'], () => {
      parentNotifications += 1;
    });
    const unsubscribeChild = subscribeDirectoryQuestion(child, 'child', () => {
      childNotifications += 1;
    });
    const parentQuestions = [{ id: 'question-parent' }] as never[];
    const childQuestions = [{ id: 'question-child' }] as never[];

    child.setState({ question: { parent: parentQuestions, child: childQuestions } });

    expect(parentNotifications).toBe(1);
    expect(childNotifications).toBe(1);

    child.setState({ part: { message: [] } });
    expect(parentNotifications).toBe(1);
    expect(childNotifications).toBe(1);

    child.setState({
      question: {
        parent: parentQuestions,
        child: [{ id: 'question-child-replacement' }] as never[],
      },
    });

    expect(parentNotifications).toBe(2);
    expect(childNotifications).toBe(2);

    child.setState({ question: {} });

    expect(parentNotifications).toBe(3);
    expect(childNotifications).toBe(3);

    unsubscribeParent();
    unsubscribeChild();
    manager.disposeAll();
  });

  test('aggregates exact question buckets across directory stores', () => {
    const manager = new ChildStoreManager();
    const parentStore = manager.ensureChild('/repo', { bootstrap: false });
    const childStore = manager.ensureChild('/worktrees/feature', { bootstrap: false });
    let notifications = 0;
    const notify = () => {
      notifications += 1;
    };
    const unsubscribers = [
      subscribeDirectoryQuestions(parentStore, ['parent'], notify),
      subscribeDirectoryQuestions(childStore, ['child'], notify),
    ];
    const questionCount = () => (
      (parentStore.getState().question.parent?.length ?? 0)
      + (childStore.getState().question.child?.length ?? 0)
    );

    childStore.setState({ question: { child: [{ id: 'child-question' }] as never[] } });
    expect(questionCount()).toBe(1);
    expect(notifications).toBe(1);

    childStore.setState({
      question: {
        ...childStore.getState().question,
        unrelated: [{ id: 'unrelated-question' }] as never[],
      },
    });
    expect(questionCount()).toBe(1);
    expect(notifications).toBe(1);

    parentStore.setState({ question: { parent: [{ id: 'parent-question' }] as never[] } });
    expect(questionCount()).toBe(2);
    expect(notifications).toBe(2);

    for (const unsubscribe of unsubscribers) unsubscribe();
    manager.disposeAll();
  });
});

describe('ChildStoreManager session message subscriptions', () => {
  test('routes annotated part changes only to the owning session', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    const notifications = new Map<string, number>();
    const unsubscribers = Array.from({ length: 50 }, (_, index) => {
      const sessionID = `session-${index}`;
      return subscribeDirectorySessionMessages(child, sessionID, () => {
        notifications.set(sessionID, (notifications.get(sessionID) ?? 0) + 1);
      });
    });
    setSyncPerformanceDiagnosticsEnabled(true);

    for (let index = 0; index < 1_000; index += 1) {
      const sessionID = `session-${index % 50}`;
      const messageID = `message-${index}`;
      markDirectorySessionPartChanged(child, sessionID, messageID);
      child.setState({ part: { ...child.getState().part, [messageID]: [] } });
    }

    expect([...notifications.values()].reduce((sum, count) => sum + count, 0)).toBe(1_000);
    expect(notifications.get('session-0')).toBe(20);
    expect(getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks).toBe(1_000);
    for (const unsubscribe of unsubscribers) unsubscribe();
    setSyncPerformanceDiagnosticsEnabled(false);
    manager.disposeAll();
  });

  test('conservatively resets active subscribers for unannotated bulk part replacement', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    let reset = false;
    const unsubscribe = subscribeDirectorySessionMessages(child, 'session-1', (change) => {
      reset = change.reset;
    });

    child.setState({ part: { message: [] } });

    expect(reset).toBe(true);
    unsubscribe();
    manager.disposeAll();
  });
});

describe('ChildStoreManager directory bootstrap scheduler', () => {
  test('bounds concurrency and eventually refreshes every queued directory', async () => {
    const manager = new ChildStoreManager();
    const running = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    let maxRunning = 0;
    manager.setBootstrapDemand('sidebar', Array.from({ length: 10 }, (_, index) => ({
      directory: `/workspace-${index}`,
      priority: 'expanded' as const,
      reason: 'project-expanded' as const,
    })));
    const cleanup = manager.configure({
      bootstrapConcurrency: 2,
      onBootstrap: ({ directory }) => {
        const task = deferred();
        running.set(directory, task);
        started.push(directory);
        maxRunning = Math.max(maxRunning, running.size);
        return task.promise.finally(() => running.delete(directory));
      },
    });

    while (started.length < 10) {
      expect(running.size <= 2).toBe(true);
      const task = running.values().next().value;
      expect(task).toBeDefined();
      task?.resolve();
      await settle();
    }
    for (const task of running.values()) task.resolve();
    await settle();

    expect(new Set(started).size).toBe(10);
    expect(maxRunning).toBe(2);
    cleanup();
    manager.disposeAll();
  });

  test('reserves capacity for foreground work while background refresh drains', async () => {
    const manager = new ChildStoreManager();
    const tasks = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    manager.setBootstrapDemand('sidebar', [
      { directory: '/background-a', priority: 'background', reason: 'known-worktree' },
      { directory: '/background-b', priority: 'background', reason: 'known-worktree' },
    ]);
    const cleanup = manager.configure({
      bootstrapConcurrency: 2,
      onBootstrap: ({ directory }) => {
        const task = deferred();
        tasks.set(directory, task);
        started.push(directory);
        return task.promise;
      },
    });

    expect(started).toEqual(['/background-a']);
    manager.requestBootstrap({ directory: '/selected', priority: 'selected', reason: 'selected-session' });
    expect(started).toEqual(['/background-a', '/selected']);

    tasks.get('/selected')?.resolve();
    tasks.get('/background-a')?.resolve();
    await settle();
    tasks.get('/background-b')?.resolve();
    await settle();
    cleanup();
    manager.disposeAll();
  });

  test('promotes a queued worktree without duplicating its execution', async () => {
    const manager = new ChildStoreManager();
    const blocker = deferred();
    const started: string[] = [];
    manager.setBootstrapDemand('sidebar', [
      { directory: '/blocker', priority: 'expanded', reason: 'project-expanded' },
      { directory: '/worktree', priority: 'background', reason: 'known-worktree' },
    ]);
    const cleanup = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: ({ directory }) => {
        started.push(directory);
        return directory === '/blocker' ? blocker.promise : Promise.resolve();
      },
    });

    manager.setBootstrapDemand('sidebar', [
      { directory: '/blocker', priority: 'expanded', reason: 'project-expanded' },
      { directory: '/worktree', priority: 'expanded', reason: 'worktree-expanded' },
    ]);
    blocker.resolve();
    await settle();
    await settle();

    expect(started).toEqual(['/blocker', '/worktree']);
    cleanup();
    manager.disposeAll();
  });

  test('failed work does not block unrelated queued directories', async () => {
    const manager = new ChildStoreManager();
    const started: string[] = [];
    manager.setBootstrapDemand('sidebar', [
      { directory: '/failed', priority: 'expanded', reason: 'project-expanded' },
      { directory: '/healthy', priority: 'expanded', reason: 'project-expanded' },
    ]);
    const cleanup = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: async ({ directory }) => {
        started.push(directory);
        if (directory === '/failed') throw new Error('failed');
      },
    });
    await settle();
    await settle();

    expect(started).toEqual(['/failed', '/healthy']);
    expect(manager.getBootstrapState('/failed')).toBe('failed');
    expect(manager.getBootstrapState('/healthy')).toBe('complete');
    cleanup();
    manager.disposeAll();
  });

  test('records os-permission failures and clears them on forced retry', async () => {
    const manager = new ChildStoreManager();
    let denied = true;
    const cleanup = manager.configure({
      onBootstrap: () => {
        if (denied) {
          throw new FilesystemError('Access denied', { reason: 'os-permission', status: 403 });
        }
      },
    });

    manager.requestBootstrap({ directory: '/protected', priority: 'selected', reason: 'current-directory' });
    await settle();
    await settle();

    expect(manager.getBootstrapState('/protected')).toBe('failed');
    expect(manager.getBootstrapFailure('/protected')).toBe('os-permission');

    denied = false;
    manager.requestBootstrap({
      directory: '/protected',
      priority: 'selected',
      reason: 'action-demand',
      force: true,
    });
    await settle();
    await settle();

    expect(manager.getBootstrapState('/protected')).toBe('complete');
    expect(manager.getBootstrapFailure('/protected')).toBe(undefined);
    cleanup();
    manager.disposeAll();
  });

  test('continues after a synchronous bootstrap failure', async () => {
    const manager = new ChildStoreManager();
    const started: string[] = [];
    manager.setBootstrapDemand('sidebar', [
      { directory: '/failed', priority: 'expanded', reason: 'project-expanded' },
      { directory: '/healthy', priority: 'expanded', reason: 'project-expanded' },
    ]);
    const cleanup = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: ({ directory }) => {
        started.push(directory);
        if (directory === '/failed') throw new Error('failed');
      },
    });

    await settle();
    await settle();

    expect(started).toEqual(['/failed', '/healthy']);
    expect(manager.getBootstrapState('/failed')).toBe('failed');
    expect(manager.getBootstrapState('/healthy')).toBe('complete');
    cleanup();
    manager.disposeAll();
  });

  test('reruns a forced manual demand that arrives while the directory is running', async () => {
    const manager = new ChildStoreManager();
    const firstRun = deferred();
    const started: string[] = [];
    const cleanup = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: ({ directory }) => {
        started.push(directory);
        return started.length === 1 ? firstRun.promise : Promise.resolve();
      },
    });

    manager.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'current-directory' });
    manager.requestBootstrap({
      directory: '/workspace',
      priority: 'selected',
      reason: 'server-connected',
      force: true,
    });
    firstRun.resolve();
    await settle();
    await settle();

    expect(started).toEqual(['/workspace', '/workspace']);
    expect(manager.getBootstrapState('/workspace')).toBe('complete');
    cleanup();
    manager.disposeAll();
  });

  test('coalesces repeated non-forced manual demands while a directory is running', async () => {
    const manager = new ChildStoreManager();
    const firstRun = deferred();
    let starts = 0;
    const cleanup = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: () => {
        starts += 1;
        return firstRun.promise;
      },
    });

    const demand = { directory: '/workspace', priority: 'selected' as const, reason: 'current-directory' as const };
    manager.requestBootstrap(demand);
    manager.requestBootstrap(demand);
    firstRun.resolve();
    await settle();
    await settle();

    expect(starts).toBe(1);
    expect(manager.getBootstrapState('/workspace')).toBe('complete');
    cleanup();
    manager.disposeAll();
  });

  test('reruns a manual demand after its bootstrap generation becomes stale', async () => {
    const manager = new ChildStoreManager();
    const staleRun = deferred();
    const started: string[] = [];
    const cleanupStale = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: () => {
        started.push('stale');
        return staleRun.promise;
      },
    });

    manager.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'current-directory' });
    cleanupStale();
    const cleanupCurrent = manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: () => {
        started.push('current');
      },
    });
    staleRun.resolve();
    await settle();
    await settle();

    expect(started).toEqual(['stale', 'current']);
    expect(manager.getBootstrapState('/workspace')).toBe('complete');
    cleanupCurrent();
    manager.disposeAll();
  });
});

describe('ChildStoreManager bootstrap context liveness', () => {
  test('isCurrent stays true after the run settles so deferred recovery work can commit', async () => {
    const manager = new ChildStoreManager();
    let captured: DirectoryBootstrapContext | undefined;
    const cleanup = manager.configure({
      onBootstrap: (context) => {
        captured = context;
      },
    });
    manager.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'current-directory' });
    await settle();
    expect(manager.getBootstrapState('/workspace')).toBe('complete');

    // bootstrapDirectory schedules deferred recovery pulls (permission.list
    // and friends) from a setTimeout(0), which always runs after the pump's
    // .finally() has cleaned up the run entry. isCurrent must remain true
    // there, or those pulls and every commit they make get skipped.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured?.isCurrent()).toBe(true);

    cleanup();
    expect(captured?.isCurrent()).toBe(false);
    manager.disposeAll();
  });

  test('a newer same-directory run invalidates the previous context', async () => {
    const manager = new ChildStoreManager();
    const contexts: DirectoryBootstrapContext[] = [];
    const cleanup = manager.configure({
      onBootstrap: (context) => {
        contexts.push(context);
      },
    });
    manager.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'current-directory' });
    await settle();
    expect(contexts[0]?.isCurrent()).toBe(true);

    // A forced rerun for the same directory must retire the previous
    // context: its in-flight deferred responses may no longer commit over
    // whatever the newer run synchronizes.
    manager.requestBootstrap({ directory: '/workspace', priority: 'selected', reason: 'server-connected', force: true });
    await settle();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.isCurrent()).toBe(false);
    expect(contexts[1]?.isCurrent()).toBe(true);

    cleanup();
    manager.disposeAll();
  });
});
