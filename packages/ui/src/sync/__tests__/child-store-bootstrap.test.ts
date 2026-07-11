import { describe, expect, test } from 'bun:test';
import { ChildStoreManager } from '../child-store';

describe('ChildStoreManager lightweight subscribers', () => {
  test('creates a subscribable store without starting directory bootstrap', () => {
    const manager = new ChildStoreManager();
    const bootstrapped: string[] = [];
    manager.configure({ onBootstrap: (directory) => bootstrapped.push(directory) });

    const store = manager.ensureChild('/sidebar-only', { bootstrap: false });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.getState().patch({ session_status: { session: { type: 'busy' } } });
    unsubscribe();

    expect(bootstrapped).toEqual([]);
    expect(notifications).toBe(1);
  });

  test('still starts bootstrap for an authoritative directory consumer', () => {
    const manager = new ChildStoreManager();
    const bootstrapped: string[] = [];
    manager.configure({ onBootstrap: (directory) => bootstrapped.push(directory) });

    manager.ensureChild('/active-chat');

    expect(bootstrapped).toEqual(['/active-chat']);
  });
});
