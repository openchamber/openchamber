import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { isSubagentsSurfaceShown, useSubagentsSurfaceShown } from './panel';

const directory = '/subagents-rail-test';
const parent: Session = {
  id: 'parent',
  projectID: 'project',
  directory,
  title: 'Parent',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
const child: Session = { ...parent, id: 'child', parentID: parent.id, title: 'Subagent' };
const workflowChild: Session = { ...parent, id: 'wf-child', parentID: parent.id, title: 'Workflow agent' };

describe('subagents rail visibility', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const sdk = OpenCode.make({ baseUrl: 'http://subagents-panel.test', fetch: () => new Promise<Response>(() => undefined) });

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win,
      document: win.document,
      navigator: win.navigator,
      Node: win.Node,
      Element: win.Element,
      HTMLElement: win.HTMLElement,
      localStorage: win.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useProjectsStore.setState({ projects: [{ id: 'project', path: directory }] });
    useGlobalSessionsStore.getState().applySnapshot([], []);
    useWorkflowRunsStore.getState().reset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
    useProjectsStore.setState({ projects: [] });
    useGlobalSessionsStore.getState().applySnapshot([], []);
    useWorkflowRunsStore.getState().reset();
    restoreGlobals();
    await win.happyDOM.close();
  });

  const Probe: React.FC = () => {
    const shown = useSubagentsSurfaceShown();
    return <span data-shown={String(shown)} />;
  };

  const renderProbe = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <Probe />
      </SyncProvider>,
    ));
  };

  const readShown = () => container.querySelector('span')?.dataset.shown === 'true';

  test('tracks live and listed subagents while ignoring workflow agents', async () => {
    await renderProbe();
    await act(async () => useSessionUIStore.setState({ currentSessionId: parent.id, currentSessionDirectory: directory }));
    const childStores = getSyncChildStores();
    const dirStore = childStores.getChild(directory);
    if (!dirStore) throw new Error('Expected directory store');

    expect(readShown()).toBe(false);
    expect(isSubagentsSurfaceShown(childStores)).toBe(false);

    // A live subagent in the directory store shows the surface immediately.
    await act(async () => dirStore.setState({ session: [parent, child] }));
    expect(readShown()).toBe(true);
    expect(isSubagentsSurfaceShown(childStores)).toBe(true);

    // Clearing live sessions hides it again.
    await act(async () => dirStore.setState({ session: [parent] }));
    expect(readShown()).toBe(false);
    expect(isSubagentsSurfaceShown(childStores)).toBe(false);

    // A workflow agent child does not trigger the Subagents rail surface.
    await act(async () => {
      useWorkflowRunsStore.getState().apply({
        id: 'run_1',
        name: 'audit',
        description: '',
        parentSessionId: parent.id,
        directory,
        state: 'running',
        attempt: 1,
        currentPhase: null,
        phases: [],
        agents: [{ key: 'a1', label: 'a1', phase: null, state: 'running', sessionId: workflowChild.id, startedAt: 1 }],
        logs: [],
        createdAt: 1,
      });
      dirStore.setState({ session: [parent, workflowChild] });
    });
    expect(readShown()).toBe(false);
    expect(isSubagentsSurfaceShown(childStores)).toBe(false);

    // A child from another worktree indexed in the global sessions store still shows the surface.
    await act(async () => {
      useGlobalSessionsStore.getState().applySnapshot([
        parent,
        { ...child, id: 'worktree-child', directory: '/other-worktree' },
      ], []);
    });
    expect(readShown()).toBe(true);
    expect(isSubagentsSurfaceShown(childStores)).toBe(true);
  });
});
