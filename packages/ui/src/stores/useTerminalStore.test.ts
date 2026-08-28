import { afterEach, describe, expect, test } from 'bun:test';
import { useTerminalStore } from './useTerminalStore';

const setup = () => {
  useTerminalStore.getState().clearAll();
  useTerminalStore.getState().ensureDirectory('/repo');
  return useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].id;
};

const buffer = (tabId: string) => useTerminalStore.getState().getBuffer('/repo', tabId);

describe('terminal state reconciliation', () => {
  afterEach(() => useTerminalStore.getState().clearAll());

  test('adopts unknown server sessions into the fresh placeholder tab', () => {
    setup();
    useTerminalStore.getState().adoptServerSessions('/repo', [
      { sessionId: 'srv-1', status: 'running', createdAt: 100 },
      { sessionId: 'srv-2', status: 'exited', createdAt: null },
    ]);
    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.tabs.map((tab) => tab.id)).toEqual(['srv-1', 'srv-2']);
    expect(state.tabs[0].terminalSessionId).toBe('srv-1');
    expect(state.tabs[0].lifecycle).toBe('running');
    expect(state.tabs[1].lifecycle).toBe('exited');
    expect(state.activeTabId).toBe('srv-1');
  });

  test('adoption is additive: existing tabs and referenced sessions survive', () => {
    const tabId = setup();
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'output', 1);
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-live');
    useTerminalStore.getState().adoptServerSessions('/repo', [
      { sessionId: 'srv-live', status: 'running', createdAt: 1 },
      { sessionId: 'srv-orphan', status: 'running', createdAt: 2 },
    ]);
    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0].id).toBe(tabId);
    expect(state.tabs[1].id).toBe('srv-orphan');
    expect(state.activeTabId).toBe(tabId);
  });

  test('re-adopting the same sessions changes nothing', () => {
    setup();
    useTerminalStore.getState().adoptServerSessions('/repo', [
      { sessionId: 'srv-1', status: 'running', createdAt: 100 },
    ]);
    const before = useTerminalStore.getState().sessions;
    useTerminalStore.getState().adoptServerSessions('/repo', [
      { sessionId: 'srv-1', status: 'running', createdAt: 100 },
    ]);
    expect(useTerminalStore.getState().sessions).toBe(before);
  });

  test('applies snapshots atomically and deduplicates output by sequence', () => {
    const tabId = setup();
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'prompt', 4);
    useTerminalStore.getState().appendToBuffer('/repo', tabId, ' output', 5);
    useTerminalStore.getState().appendToBuffer('/repo', tabId, ' duplicate', 5);
    expect(buffer(tabId).chunks.map((chunk) => chunk.data).join('')).toBe('prompt output');
    expect(buffer(tabId).lastSequence).toBe(5);
  });

  test('keeps raw live bytes separate from replay-safe bytes', () => {
    const tabId = setup();
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'prompt\u001b[6n', 1, 'prompt');
    const chunk = buffer(tabId).chunks[0];
    expect(chunk.data).toBe('prompt\u001b[6n');
    expect(chunk.replayData).toBe('prompt');
  });

  test('uses collision-resistant tab identities', () => {
    const tabId = setup();
    expect(/^tab-\d+$/.test(tabId)).toBe(false);
  });

  test('does not let stale snapshots replace newer output', () => {
    const tabId = setup();
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'new', 8);
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'stale', 7);
    expect(buffer(tabId).chunks[0].data).toBe('new');
  });

  test('preserves buffer identity for an identical snapshot', () => {
    const tabId = setup();
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'prompt', 8);
    const previous = buffer(tabId).chunks;
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'prompt', 8);
    expect(buffer(tabId).chunks).toBe(previous);
  });

  test('caps multibyte scrollback by UTF-8 bytes', () => {
    const tabId = setup();
    useTerminalStore.getState().appendToBuffer('/repo', tabId, '界'.repeat(200_000), 1);
    expect(buffer(tabId).byteLength <= 512 * 1024).toBe(true);
    expect(new TextEncoder().encode(buffer(tabId).chunks[0].data).byteLength).toBe(buffer(tabId).byteLength);
  });

  test('returns a stable empty buffer for tabs that produced no output', () => {
    const tabId = setup();
    expect(buffer(tabId).chunks.length).toBe(0);
    expect(buffer(tabId)).toBe(useTerminalStore.getState().getBuffer('/repo', 'unknown-tab'));
  });

  // Scale guard: everything `partialize` reads must stay referentially unchanged
  // while output streams, otherwise persistence and the tab strip go back to
  // doing per-chunk work that grows with the number of open terminals.
  test('streaming output keeps tab metadata and persisted inputs referentially stable', () => {
    const first = setup();
    const second = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().ensureDirectory('/other');
    const otherTab = useTerminalStore.getState().getDirectoryState('/other')!.tabs[0].id;

    const sessionsBefore = useTerminalStore.getState().sessions;
    const repoBefore = useTerminalStore.getState().getDirectoryState('/repo');
    const otherBefore = useTerminalStore.getState().getDirectoryState('/other');
    const nextTabIdBefore = useTerminalStore.getState().nextTabId;

    const tabs: Array<[string, string]> = [['/repo', first], ['/repo', second], ['/other', otherTab]];
    for (let index = 0; index < 90; index += 1) {
      const [directory, tabId] = tabs[index % tabs.length];
      useTerminalStore.getState().appendToBuffer(directory, tabId, `line ${index}\n`, index + 1);
    }

    expect(useTerminalStore.getState().sessions).toBe(sessionsBefore);
    expect(useTerminalStore.getState().getDirectoryState('/repo')).toBe(repoBefore);
    expect(useTerminalStore.getState().getDirectoryState('/other')).toBe(otherBefore);
    expect(useTerminalStore.getState().nextTabId).toBe(nextTabIdBefore);
    expect(buffer(first).chunks.length).toBe(30);

    useTerminalStore.getState().removeDirectory('/other');
  });

  test('drops scrollback when a tab is closed or its directory is removed', () => {
    const first = setup();
    const second = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().appendToBuffer('/repo', first, 'first', 1);
    useTerminalStore.getState().appendToBuffer('/repo', second, 'second', 1);
    expect(useTerminalStore.getState().buffers.size).toBe(2);

    useTerminalStore.getState().closeTab('/repo', second);
    expect(useTerminalStore.getState().buffers.size).toBe(1);
    expect(buffer(first).chunks[0].data).toBe('first');

    useTerminalStore.getState().removeDirectory('/repo');
    expect(useTerminalStore.getState().buffers.size).toBe(0);
  });

  test('resets scrollback when a tab is bound to a different terminal session', () => {
    const tabId = setup();
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'session-a');
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'from a', 1);
    expect(buffer(tabId).chunks.length).toBe(1);

    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'session-b');
    expect(buffer(tabId)).toBe(useTerminalStore.getState().getBuffer('/repo', 'never-used'));
  });

  test('ignores output for tabs that no longer exist', () => {
    setup();
    useTerminalStore.getState().appendToBuffer('/repo', 'ghost-tab', 'output', 1);
    useTerminalStore.getState().replaceBuffer('/repo', 'ghost-tab', 'snapshot', 1);
    expect(useTerminalStore.getState().buffers.size).toBe(0);
  });
});

describe('default terminal tab labels', () => {
  afterEach(() => useTerminalStore.getState().clearAll());

  const labels = () =>
    useTerminalStore.getState().getDirectoryState('/repo')!.tabs.map((tab) => tab.label);

  // Regression for https://github.com/openchamber/openchamber/issues/2718
  test('does not reuse the number of a closed tab', () => {
    const first = setup();
    useTerminalStore.getState().createTab('/repo');
    expect(labels()).toEqual(['Terminal', 'Terminal 2']);

    useTerminalStore.getState().closeTab('/repo', first);
    useTerminalStore.getState().createTab('/repo');

    expect(labels()).toEqual(['Terminal 2', 'Terminal 3']);
  });

  test('numbers past a user-renamed "Terminal N" label instead of duplicating it', () => {
    const first = setup();
    useTerminalStore.getState().setTabLabel('/repo', first, 'Terminal 5');
    useTerminalStore.getState().createTab('/repo');

    expect(labels()).toEqual(['Terminal 5', 'Terminal 6']);
  });

  test('ignores custom labels and starts over at "Terminal" when no default-labeled tabs remain', () => {
    const first = setup();
    useTerminalStore.getState().setTabLabel('/repo', first, 'build');
    useTerminalStore.getState().createTab('/repo');

    expect(labels()).toEqual(['build', 'Terminal']);
  });
});
