import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { opencodeClient } from '@/lib/opencode/client';
import * as sessionActions from '@/sync/session-actions';
import * as worktreeManager from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { TodoSendExecution } from '../todoSendExecution';

const dom = new Window();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

type DirectoryDefaults = { agentName?: string; providerId: string; modelId: string; variant?: string | null };

const projectRef = { id: 'project-1', path: '/repo' };
const worktreeDirectory = '/repo/.oc/worktrees/quiet-otter/app';
const directoryBeforeCreate = '/repo/packages/app';

let directoryDefaults: Record<string, DirectoryDefaults | null> = {};
const resolvedDirectories: string[] = [];
const sends: Array<{ providerID: string; modelID: string; agent?: string; variant?: string | null }> = [];
const savedSelections: string[] = [];
const createdSessions: string[] = [];
const switchedModels: Array<{ sessionId: string; model: unknown; directory: unknown }> = [];
const directoriesSet: Array<{ path: string; options: unknown }> = [];
let previousDirectory = directoryBeforeCreate;

const sessionState = {
  currentSessionId: 'session-elsewhere',
  createSession: async (_title: string | undefined, directory: string) => {
    createdSessions.push(directory);
    return { id: 'session-plain', directory };
  },
  initializeNewOpenChamberSession: () => undefined,
  sendMessage: async (
    _content: string,
    providerID: string,
    modelID: string,
    agent?: string,
    _attachments?: readonly object[],
    _mention?: string,
    _parts?: readonly object[],
    variant?: string | null,
  ) => {
    sends.push({ providerID, modelID, agent, variant });
  },
  setCurrentSession: () => undefined,
};
const selectFrom = <T,>(state: T) => Object.assign(
  <R,>(selector: (value: T) => R): R => selector(state),
  { getState: () => state },
);

const toastErrors: string[] = [];
mock.module('@/components/ui', () => ({ toast: { success: () => undefined, error: (message: string) => { toastErrors.push(message); } } }));
mock.module('@/lib/git/branchNameGenerator', () => ({ generateBranchName: () => 'quiet-otter' }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/magicPrompts', () => ({
  loadMagicPrompts: async () => ({ render: (key: string) => key }),
}));
mock.module('@/lib/worktreeSessionCreator', () => ({
  createWorktreeSessionForNewBranch: async () => ({
    id: 'session-worktree', branch: 'quiet-otter', path: '/repo/.oc/worktrees/quiet-otter', directory: worktreeDirectory, previousDirectory,
  }),
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: selectFrom({
    agents: [],
    resolveDirectoryDefaultSelection: async (directory: string) => {
      resolvedDirectories.push(directory);
      return directoryDefaults[directory] ?? null;
    },
  }),
}));
mock.module('@/stores/useUIStore', () => ({ useUIStore: selectFrom({ setSessionSwitcherOpen: () => undefined }) }));
mock.module('@/sync/input-store', () => ({ useInputStore: selectFrom({ setPendingInputText: () => undefined }) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: selectFrom(sessionState) }));
mock.module('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => {
        savedSelections.push(`${sessionId} model ${providerId}/${modelId}`);
      },
      saveSessionAgentSelection: (sessionId: string, agent: string) => {
        savedSelections.push(`${sessionId} agent ${agent}`);
      },
      saveAgentModelForSession: () => undefined,
      saveAgentModelVariantForSession: (sessionId: string, agent: string, providerId: string, modelId: string, variant: string | undefined) => {
        savedSelections.push(`${sessionId} variant ${agent} ${providerId}/${modelId} ${variant ?? '-'}`);
      },
    }),
  },
}));

const { createRoot } = await import('react-dom/client');
const { useProjectTodoSend } = await import('./useProjectTodoSend');

type Send = ReturnType<typeof useProjectTodoSend>;

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
let latest: Send | null = null;

function Probe() {
  latest = useProjectTodoSend({ projectRef, canCreateWorktree: true });
  return null;
}

const send = async (kind: 'worktree' | 'session', execution: TodoSendExecution) => {
  await act(async () => root.render(<Probe />));
  await act(async () => {
    if (kind === 'worktree') latest?.sendToNewWorktreeSession('todo-1', 'Fix the bug');
    else latest?.sendToNewSession('todo-1', 'Fix the bug');
  });
  await act(async () => { await latest?.confirmSend(execution); });
};

// What the dialog captured from the composer of another project.
const capturedElsewhere = (picked: TodoSendExecution['picked']): TodoSendExecution => ({
  providerID: 'other', modelID: 'stale-model', variant: 'low', agent: 'build', picked,
});

beforeEach(() => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async (sessionId, model, directory) => { switchedModels.push({ sessionId, model, directory }); });
  spyOn(sessionActions, 'deleteSession').mockImplementation(async () => true);
  spyOn(worktreeManager, 'removeProjectWorktree').mockImplementation(async () => undefined);
  directoryDefaults = {};
  resolvedDirectories.length = 0;
  sends.length = 0;
  savedSelections.length = 0;
  createdSessions.length = 0;
  switchedModels.length = 0;
  toastErrors.length = 0;
  directoriesSet.length = 0;
  useDirectoryStore.setState({ currentDirectory: worktreeDirectory });
  spyOn(useDirectoryStore.getState(), 'setDirectory').mockImplementation((path, options) => { directoriesSet.push({ path, options }); });
  previousDirectory = directoryBeforeCreate;
});

afterEach(() => mock.restore());

afterAll(() => {
  act(() => root.unmount());
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('a new worktree session starts on the defaults of the directory it lands in', async () => {
  directoryDefaults[worktreeDirectory] = { agentName: 'plan', providerId: 'anthropic', modelId: 'claude', variant: 'high' };

  await send('worktree', capturedElsewhere({ model: false, variant: false, agent: false }));

  expect(resolvedDirectories).toEqual([worktreeDirectory]);
  expect(sends).toEqual([{ providerID: 'anthropic', modelID: 'claude', agent: 'plan', variant: 'high' }]);
  expect(savedSelections).toEqual([
    'session-worktree model anthropic/claude',
    'session-worktree agent plan',
    'session-worktree variant plan anthropic/claude high',
  ]);
  // The worktree session is created before its execution is known: the model this send chose is written once, right after create.
  expect(switchedModels).toEqual([{ sessionId: 'session-worktree', model: { providerID: 'anthropic', id: 'claude', variant: 'high' }, directory: worktreeDirectory }]);
});

test('a failed model switch in a new worktree session tells the user and sends no prompt', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(toastErrors).toEqual(['Could not switch the model']);
  expect(sends).toEqual([]);
  expect(savedSelections).toEqual([]);
});

test('a failed model switch in a new worktree session removes the session and the worktree this gesture created', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  const deleted = spyOn(sessionActions, 'deleteSession').mockImplementation(async () => true);
  const removed = spyOn(worktreeManager, 'removeProjectWorktree').mockImplementation(async () => undefined);

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(deleted.mock.calls).toEqual([['session-worktree']]);
  expect(removed.mock.calls).toEqual([[
    projectRef,
    { path: '/repo/.oc/worktrees/quiet-otter', projectDirectory: '/repo', branch: 'quiet-otter', label: 'quiet-otter' },
    { deleteLocalBranch: true },
  ]]);
  expect(toastErrors).toEqual(['Could not switch the model']);
});

test('a session that cannot be removed after a failed switch is reported and keeps its worktree', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  spyOn(sessionActions, 'deleteSession').mockImplementation(async () => false);
  const removed = spyOn(worktreeManager, 'removeProjectWorktree').mockImplementation(async () => undefined);

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(removed).not.toHaveBeenCalled();
  expect(toastErrors).toEqual(['Could not switch the model', 'The new session (session-worktree) could not be removed. Its worktree was kept.']);
  expect(directoriesSet).toEqual([]);
});

test('a worktree that cannot be removed after a failed switch is reported', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  spyOn(sessionActions, 'deleteSession').mockImplementation(async () => true);
  spyOn(worktreeManager, 'removeProjectWorktree').mockImplementation(async () => { throw new Error('busy'); });

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(toastErrors).toEqual(['Could not switch the model', 'The new worktree (/repo/.oc/worktrees/quiet-otter) could not be removed.']);
  expect(directoriesSet).toEqual([]);
});

test('the chat goes back to the folder it was on once the discarded worktree is gone', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(directoriesSet).toEqual([{ path: directoryBeforeCreate, options: { showOverlay: false } }]);
});

test('a discarded worktree send with no earlier folder puts the chat on the project', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  previousDirectory = '';

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(directoriesSet).toEqual([{ path: '/repo', options: { showOverlay: false } }]);
});

test('a discarded worktree send leaves a folder the user has since moved to alone', async () => {
  spyOn(opencodeClient, 'switchSessionModel').mockImplementation(async () => { throw new Error('offline'); });
  useDirectoryStore.setState({ currentDirectory: '/elsewhere' });
  spyOn(useDirectoryStore.getState(), 'setDirectory').mockImplementation((path, options) => { directoriesSet.push({ path, options }); });

  await send('worktree', capturedElsewhere({ model: true, variant: true, agent: true }));

  expect(directoriesSet).toEqual([]);
});

test('a pick made in the dialog wins over the directory defaults', async () => {
  directoryDefaults[worktreeDirectory] = { agentName: 'plan', providerId: 'anthropic', modelId: 'claude', variant: 'high' };

  await send('worktree', capturedElsewhere({ model: true, variant: false, agent: false }));

  // The picked model keeps the effort the dialog chose for it; the agent follows the directory.
  expect(sends).toEqual([{ providerID: 'other', modelID: 'stale-model', agent: 'plan', variant: 'low' }]);
});

test('an agent the directory cannot name yet is left to OpenCode for that directory', async () => {
  directoryDefaults[worktreeDirectory] = { providerId: 'anthropic', modelId: 'claude' };

  await send('worktree', capturedElsewhere({ model: false, variant: false, agent: false }));

  expect(sends).toEqual([{ providerID: 'anthropic', modelID: 'claude', agent: undefined, variant: undefined }]);
  expect(savedSelections).toEqual(['session-worktree model anthropic/claude']);
});

test('a session in the project itself sends what the dialog shows', async () => {
  await send('session', capturedElsewhere({ model: false, variant: false, agent: false }));

  expect(resolvedDirectories).toEqual([]);
  expect(createdSessions).toEqual(['/repo']);
  expect(sends).toEqual([{ providerID: 'other', modelID: 'stale-model', agent: 'build', variant: 'low' }]);
  // A session in the project itself gets its model through the create call, so nothing is written after it.
  expect(switchedModels).toEqual([]);
});
