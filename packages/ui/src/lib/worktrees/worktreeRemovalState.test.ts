import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

// The module subscribes to runtime switches at import, which needs a window.
const dom = new Window({ url: 'http://instance-a.test' });
for (const [name, value] of Object.entries({ window: dom, CustomEvent: dom.CustomEvent })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const {
  clearWorktreeRemoval,
  isWorktreeRemoving,
  markWorktreeRemoving,
} = await import('./worktreeRemovalState');

describe('worktree removal state', () => {
  test('one path spelling marks the row for every other spelling', () => {
    markWorktreeRemoving('C:\\worktrees\\feature\\');
    expect(isWorktreeRemoving('C:/worktrees/feature')).toBe(true);
    clearWorktreeRemoval('C:/worktrees/feature/');
    expect(isWorktreeRemoving('C:\\worktrees\\feature')).toBe(false);
  });

  test('clearing one path leaves the others removing', () => {
    markWorktreeRemoving('/worktrees/a');
    markWorktreeRemoving('/worktrees/b');
    clearWorktreeRemoval('/worktrees/a');
    expect(isWorktreeRemoving('/worktrees/a')).toBe(false);
    expect(isWorktreeRemoving('/worktrees/b')).toBe(true);
    clearWorktreeRemoval('/worktrees/b');
  });

  test('switching to another instance forgets every removal', () => {
    markWorktreeRemoving('/worktrees/a');
    switchRuntimeEndpoint({ apiBaseUrl: 'http://instance-b.test', runtimeKey: 'instance-b' });
    expect(isWorktreeRemoving('/worktrees/a')).toBe(false);
  });
});
