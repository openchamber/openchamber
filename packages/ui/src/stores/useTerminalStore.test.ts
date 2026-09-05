import { afterEach, describe, expect, test } from 'bun:test';

import type { TerminalServerSession } from '@/lib/api/types';

import { directoryMayHaveActiveProjectAction, useTerminalStore } from './useTerminalStore';

const setup = () => {
  useTerminalStore.getState().clearAll();
  useTerminalStore.getState().ensureDirectory('/repo');
  return useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].id;
};

const buffer = (tabId: string) => useTerminalStore.getState().getBuffer('/repo', tabId);

const staleBuildSession: TerminalServerSession = {
  sessionId: 'srv-old',
  cwd: '/repo',
  status: 'running',
  createdAt: 1,
  mode: 'command',
  purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-old' },
};

const captureStartedActionMutationRevisions = (directory: string) => {
  return useTerminalStore.getState().captureStartedActionMutationRevisions(directory);
};

const reconcileServerSessionsWithStartedRevisions = (
  directory: string,
  serverSessions: TerminalServerSession[],
  startedActionMutationRevisions: ReadonlyMap<string, number>,
) => {
  useTerminalStore.getState().reconcileServerSessions(directory, serverSessions, { startedActionMutationRevisions });
};

describe('terminal state reconciliation', () => {
  afterEach(() => useTerminalStore.getState().clearAll());

  test('reconciles unknown server sessions into the fresh placeholder tab', () => {
    setup();
    useTerminalStore.getState().reconcileServerSessions('/repo', [
      { sessionId: 'srv-1', cwd: '/repo', status: 'running', createdAt: 100 },
      { sessionId: 'srv-2', cwd: '/repo', status: 'exited', createdAt: null },
    ]);
    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.tabs.map((tab) => tab.id)).toEqual(['srv-1', 'srv-2']);
    expect(state.tabs[0].terminalSessionId).toBe('srv-1');
    expect(state.tabs[0].lifecycle).toBe('running');
    expect(state.tabs[1].lifecycle).toBe('exited');
    expect(state.activeTabId).toBe('srv-1');
  });

  test('reconciliation keeps existing interactive tabs and adopts unknown sessions', () => {
    const tabId = setup();
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'output', 1);
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-live');
    useTerminalStore.getState().reconcileServerSessions('/repo', [
      { sessionId: 'srv-live', cwd: '/repo', status: 'running', createdAt: 1 },
      { sessionId: 'srv-orphan', cwd: '/repo', status: 'running', createdAt: 2 },
    ]);
    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0].id).toBe(tabId);
    expect(state.tabs[1].id).toBe('srv-orphan');
    expect(state.activeTabId).toBe(tabId);
  });

  test('re-reconciling the same sessions changes nothing', () => {
    setup();
    useTerminalStore.getState().reconcileServerSessions('/repo', [
      { sessionId: 'srv-1', cwd: '/repo', status: 'running', createdAt: 100 },
    ]);
    const before = useTerminalStore.getState().sessions;
    useTerminalStore.getState().reconcileServerSessions('/repo', [
      { sessionId: 'srv-1', cwd: '/repo', status: 'running', createdAt: 100 },
    ]);
    expect(useTerminalStore.getState().sessions).toBe(before);
  });

  test('successful empty reconciliation with no local directory keeps the original sessions reference', () => {
    const before = useTerminalStore.getState().sessions;
    useTerminalStore.getState().reconcileServerSessions('/missing', []);
    expect(useTerminalStore.getState().sessions).toBe(before);
  });

  test('hydrates persisted action tabs with live fields reset until server authority returns', () => {
    const mergePersistedState = useTerminalStore.persist.getOptions().merge;
    if (!mergePersistedState) {
      throw new Error('expected persisted merge helper');
    }
    const hydrated = mergePersistedState({
      sessions: [[
        '/repo',
        {
          activeTabId: 'tab-a',
          tabs: [{ id: 'tab-a', label: 'Build', iconKey: 'build', createdAt: 10, purpose: { type: 'project-action', actionId: 'build' } }],
        },
      ]],
      nextTabId: 2,
    }, useTerminalStore.getState());
    const tab = hydrated.sessions.get('/repo')?.tabs[0];
    expect(tab?.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });
    expect(tab?.lifecycle).toBe('idle');
    expect(tab?.terminalSessionId).toBeNull();
  });

  test('adopts an existing running project-action session by action id across clients', () => {
    const tabId = setup();
    useTerminalStore.getState().setTabPurpose('/repo', tabId, { type: 'project-action', actionId: 'build', executionId: null });
    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-shared',
      cwd: '/repo',
      status: 'running',
      createdAt: 1,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-2' },
    }]);
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.id).toBe(tabId);
    expect(tab.terminalSessionId).toBe('srv-shared');
    expect(tab.lifecycle).toBe('running');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: 'exec-2' });
  });

  test('activates a rebound running project-action tab when the current active tab is idle and sessionless', () => {
    const actionTabId = setup();
    const shellTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabPurpose('/repo', actionTabId, { type: 'project-action', actionId: 'build', executionId: null });
    useTerminalStore.getState().setActiveTab('/repo', shellTabId);

    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-build',
      cwd: '/repo',
      status: 'running',
      createdAt: 10,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    }]);

    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.activeTabId).toBe(actionTabId);
  });

  test('does not activate a rebound running project-action tab when the current active tab is a live running terminal', () => {
    const actionTabId = setup();
    const shellTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabPurpose('/repo', actionTabId, { type: 'project-action', actionId: 'build', executionId: null });
    useTerminalStore.getState().setTabSessionId('/repo', shellTabId, 'srv-shell');
    useTerminalStore.getState().setActiveTab('/repo', shellTabId);

    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-build',
      cwd: '/repo',
      status: 'running',
      createdAt: 10,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    }]);

    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.activeTabId).toBe(shellTabId);
  });

  test('does not activate an exited adopted project-action tab', () => {
    const actionTabId = setup();
    const shellTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabPurpose('/repo', actionTabId, { type: 'project-action', actionId: 'build', executionId: null });
    useTerminalStore.getState().setActiveTab('/repo', shellTabId);

    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-build',
      cwd: '/repo',
      status: 'exited',
      createdAt: 10,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    }]);

    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.activeTabId).toBe(shellTabId);
  });

  test('activates the newest adopted running project action when multiple qualify in one reconciliation', () => {
    const firstActionTabId = setup();
    const secondActionTabId = useTerminalStore.getState().createTab('/repo');
    const shellTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabPurpose('/repo', firstActionTabId, { type: 'project-action', actionId: 'build', executionId: null });
    useTerminalStore.getState().setTabPurpose('/repo', secondActionTabId, { type: 'project-action', actionId: 'test', executionId: null });
    useTerminalStore.getState().setActiveTab('/repo', shellTabId);

    useTerminalStore.getState().reconcileServerSessions('/repo', [
      {
        sessionId: 'srv-build',
        cwd: '/repo',
        status: 'running',
        createdAt: 10,
        mode: 'command',
        purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
      },
      {
        sessionId: 'srv-test',
        cwd: '/repo',
        status: 'running',
        createdAt: 20,
        mode: 'command',
        purpose: { type: 'project-action', actionId: 'test', executionId: 'exec-2' },
      },
    ]);

    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.activeTabId).toBe(secondActionTabId);
  });

  // Activation transitions always rewrite the affected tab (session id or
  // lifecycle changes), so there is no reachable activation without a tab
  // update; this pins the in-place rebind case where only one tab mutates
  // and no tab is added, removed, or reordered.
  test('activates an in-place running rebind of an existing action tab without structural tab changes', () => {
    const actionTabId = setup();
    const shellTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabPurpose('/repo', actionTabId, { type: 'project-action', actionId: 'build', executionId: 'exec-1' });
    useTerminalStore.getState().setTabSessionId('/repo', actionTabId, 'srv-build', { expectedExecutionId: 'exec-1' });
    useTerminalStore.getState().setActiveTab('/repo', shellTabId);
    useTerminalStore.getState().setTabLifecycle('/repo', actionTabId, 'idle', { expectedExecutionId: 'exec-1' });

    const beforeTabs = useTerminalStore.getState().getDirectoryState('/repo')!.tabs;

    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-build',
      cwd: '/repo',
      status: 'running',
      createdAt: beforeTabs[0]!.createdAt,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    }]);

    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.tabs).not.toBe(beforeTabs);
    expect(state.activeTabId).toBe(actionTabId);
  });

  test('gives unknown adopted action sessions a generic fallback label and icon', () => {
    setup();
    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-build',
      cwd: '/repo',
      status: 'running',
      createdAt: 1,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'unknown-action', executionId: 'exec-1' },
    }]);
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.label).toBe('unknown-action');
    expect(tab.iconKey).toBe('play');
  });

  test('successful empty reconciliation exits known action sessions without touching unrelated directories', () => {
    const repoTab = setup();
    useTerminalStore.getState().setTabPurpose('/repo', repoTab, { type: 'project-action', actionId: 'build', executionId: 'exec-1' });
    useTerminalStore.getState().setTabSessionId('/repo', repoTab, 'srv-build');
    useTerminalStore.getState().ensureDirectory('/other');
    const otherBefore = useTerminalStore.getState().getDirectoryState('/other');
    useTerminalStore.getState().reconcileServerSessions('/repo', []);
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.lifecycle).toBe('exited');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });
    expect(useTerminalStore.getState().getDirectoryState('/other')).toBe(otherBefore);
  });

  test('normalizes executionId to null when adopting an exited project-action session', () => {
    const tabId = setup();
    useTerminalStore.getState().setTabPurpose('/repo', tabId, { type: 'project-action', actionId: 'build', executionId: null });

    useTerminalStore.getState().reconcileServerSessions('/repo', [{
      sessionId: 'srv-build',
      cwd: '/repo',
      status: 'exited',
      createdAt: 10,
      mode: 'command',
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-server' },
    }]);

    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });
  });

  test('an old empty snapshot preserves a newer starting action execution', () => {
    const tabId = setup();
    const startedActionMutationRevisions = captureStartedActionMutationRevisions('/repo');

    const executionId = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build');

    expect(executionId).not.toBeNull();

    reconcileServerSessionsWithStartedRevisions('/repo', [], startedActionMutationRevisions);

    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.lifecycle).toBe('starting');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId });
    expect(tab.terminalSessionId).toBeNull();
  });

  test('an old empty snapshot still preserves the action after it becomes running before apply', () => {
    const tabId = setup();
    const startedActionMutationRevisions = captureStartedActionMutationRevisions('/repo');

    const executionId = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build');
    if (!executionId) {
      throw new Error('expected execution id');
    }
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-build', { expectedExecutionId: executionId });

    reconcileServerSessionsWithStartedRevisions('/repo', [], startedActionMutationRevisions);

    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.lifecycle).toBe('running');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId });
    expect(tab.terminalSessionId).toBe('srv-build');
  });

  test('an old listed action session does not overwrite a newer execution after allocate', () => {
    const tabId = setup();
    useTerminalStore.getState().setTabPurpose('/repo', tabId, { type: 'project-action', actionId: 'build', executionId: 'exec-old' });
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-old', { expectedExecutionId: 'exec-old' });

    const startedActionMutationRevisions = captureStartedActionMutationRevisions('/repo');
    const executionId = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build');

    reconcileServerSessionsWithStartedRevisions('/repo', [staleBuildSession], startedActionMutationRevisions);

    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.lifecycle).toBe('starting');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId });
    expect(tab.terminalSessionId).toBeNull();
  });

  test('an old listed action session does not overwrite a newer running session after setTabSessionId', () => {
    const tabId = setup();
    useTerminalStore.getState().setTabPurpose('/repo', tabId, { type: 'project-action', actionId: 'build', executionId: 'exec-old' });
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-old', { expectedExecutionId: 'exec-old' });

    const startedActionMutationRevisions = captureStartedActionMutationRevisions('/repo');
    const executionId = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build');
    if (!executionId) {
      throw new Error('expected execution id');
    }
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-new', { expectedExecutionId: executionId });

    reconcileServerSessionsWithStartedRevisions('/repo', [staleBuildSession], startedActionMutationRevisions);

    const tabs = useTerminalStore.getState().getDirectoryState('/repo')!.tabs;
    expect(tabs).toHaveLength(1);
    const tab = tabs[0]!;
    expect(tab.lifecycle).toBe('running');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId });
    expect(tab.terminalSessionId).toBe('srv-new');
  });

  test('a fresh empty snapshot still clears an omitted action execution', () => {
    const tabId = setup();
    const executionId = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build');
    if (!executionId) {
      throw new Error('expected execution id');
    }
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-build', { expectedExecutionId: executionId });

    const startedActionMutationRevisions = captureStartedActionMutationRevisions('/repo');
    reconcileServerSessionsWithStartedRevisions('/repo', [], startedActionMutationRevisions);

    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.lifecycle).toBe('exited');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });
    expect(tab.terminalSessionId).toBe('srv-build');
  });

  test('execution-guarded transitions ignore stale completions after a rerun', () => {
    const tabId = setup();
    const firstExecution = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build')!;
    const secondExecution = useTerminalStore.getState().allocateActionExecution('/repo', tabId, 'build')!;
    expect(firstExecution).not.toBe(secondExecution);
    useTerminalStore.getState().setTabSessionId('/repo', tabId, 'srv-old', { expectedExecutionId: firstExecution });
    useTerminalStore.getState().setTabLifecycle('/repo', tabId, 'running', { expectedExecutionId: secondExecution });
    const tab = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!;
    expect(tab.terminalSessionId).toBeNull();
    expect(tab.lifecycle).toBe('running');
    expect(tab.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: secondExecution });
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

describe('directoryMayHaveActiveProjectAction', () => {
  test('returns true for any non-exited project-action tab', () => {
    expect(directoryMayHaveActiveProjectAction({
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          terminalSessionId: null,
          lifecycle: 'idle',
          purpose: { type: 'project-action', actionId: 'build', executionId: null },
          label: 'Build',
          iconKey: 'play',
          isConnecting: false,
          createdAt: 1,
          previewUrl: null,
          previewAutoOpened: false,
          previewUrlLocked: false,
        },
      ],
    })).toBe(true);
    expect(directoryMayHaveActiveProjectAction(undefined)).toBe(false);
  });
});

test('a retained exited run cannot replace the live run of the same action', () => {
  const live: TerminalServerSession = { sessionId: 'a', cwd: '/repo', status: 'running', createdAt: 1, mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'live' } };
  const old: TerminalServerSession = { sessionId: 'b', cwd: '/repo', status: 'exited', createdAt: 2, mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'old' } };
  for (const sessions of [[live, old], [old, live]]) {
    useTerminalStore.getState().clearAll();
    useTerminalStore.getState().reconcileServerSessions('/repo', sessions);
    const tabs = useTerminalStore.getState().getDirectoryState('/repo')?.tabs;
    expect(tabs?.find((tab) => tab.purpose.type === 'project-action')?.terminalSessionId).toBe('a');
  }
});

test('a fresh running listing does not cancel an in-progress stop of the same execution', () => {
  useTerminalStore.getState().clearAll();
  const session: TerminalServerSession = { sessionId: 'run', cwd: '/repo', status: 'running', createdAt: 1, purpose: { type: 'project-action', actionId: 'build', executionId: 'run' } };
  const store = useTerminalStore.getState();
  store.reconcileServerSessions('/repo', [session]);
  store.setTabLifecycle('/repo', 'run', 'stopping');
  store.reconcileServerSessions('/repo', [session], { startedActionMutationRevisions: store.captureStartedActionMutationRevisions('/repo') });
  expect(store.getActiveTab('/repo')?.lifecycle).toBe('stopping');
});

test('adopting a replacement resets its buffer while reconnecting to the same run preserves it', () => {
  useTerminalStore.getState().clearAll();
  const store = useTerminalStore.getState();
  const session: TerminalServerSession = { sessionId: 'run', cwd: '/repo', status: 'running', createdAt: 1, purpose: { type: 'project-action', actionId: 'build', executionId: 'run' } };
  store.reconcileServerSessions('/repo', [session]);
  store.replaceBuffer('/repo', 'run', 'old output', 5);
  store.reconcileServerSessions('/repo', [session]);
  expect(store.getBuffer('/repo', 'run').lastSequence).toBe(5);
  store.reconcileServerSessions('/repo', [{ ...session, sessionId: 'replacement', purpose: { type: 'project-action', actionId: 'build', executionId: 'replacement' } }]);
  store.replaceBuffer('/repo', 'run', 'new output', 1);
  expect(store.getBuffer('/repo', 'run').chunks.map(chunk => chunk.data).join('')).toBe('new output');
});


test('a listing started before closing an action cannot resurrect its tab', () => {
  useTerminalStore.getState().clearAll();
  const store = useTerminalStore.getState();
  const session: TerminalServerSession = { sessionId: 'run', cwd: '/repo', status: 'exited', createdAt: 1, purpose: { type: 'project-action', actionId: 'build', executionId: 'run' } };
  store.reconcileServerSessions('/repo', [session]);
  const startedActionMutationRevisions = store.captureStartedActionMutationRevisions('/repo');
  store.closeTab('/repo', 'run');
  store.reconcileServerSessions('/repo', [session], { startedActionMutationRevisions });
  expect(store.getDirectoryState('/repo')?.tabs.some(tab => tab.purpose.type === 'project-action')).toBe(false);
});

test('a Windows directory keys one store entry however the caller spells it', () => {
  useTerminalStore.getState().clearAll();
  const store = useTerminalStore.getState();
  const session: TerminalServerSession = { sessionId: 'run', cwd: 'c:\\repo', status: 'running', createdAt: 1, purpose: { type: 'project-action', actionId: 'dev', executionId: 'run' } };
  // The sidebar reconciles from the server's `cwd`; the terminal panel and the
  // project actions button pass the directory they were handed.
  store.reconcileServerSessions('c:\\repo', [session]);

  expect(useTerminalStore.getState().sessions.size).toBe(1);
  expect(directoryMayHaveActiveProjectAction(store.getDirectoryState('C:/repo/'))).toBe(true);
  expect(store.getDirectoryState('C:\\repo')?.tabs).toHaveLength(1);
});
