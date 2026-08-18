import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { AgentMemoryDisabledError, type AgentMemoryEntry } from '@/lib/agentMemoryApi';

function entry(overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    id: 'mem-1',
    title: 'Uses bun',
    body: 'Tests run with bun test.',
    type: 'fact',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface MemoryReadResult {
  global: AgentMemoryEntry[];
  project: AgentMemoryEntry[];
  globalFailed: boolean;
  projectFailed: boolean;
}

/**
 * Swappable implementations rather than mock helpers: each test states the one
 * behaviour it needs.
 */
let readImpl: () => Promise<MemoryReadResult>;
let deleteImpl: () => Promise<void>;
let updateImpl: (memoryId: string, patch: Record<string, unknown>) => Promise<AgentMemoryEntry>;
let lastPatch: Record<string, unknown> | null = null;

mock.module('@/lib/agentMemoryApi', () => ({
  AgentMemoryDisabledError,
  fetchAgentMemory: () => readImpl(),
  deleteAgentMemory: () => deleteImpl(),
  updateAgentMemory: (
    _scope: string,
    _projectPath: string | null,
    memoryId: string,
    patch: Record<string, unknown>,
  ) => {
    lastPatch = patch;
    return updateImpl(memoryId, patch);
  },
}));

const { useAgentMemoryStore } = await import('./useAgentMemoryStore');

beforeEach(() => {
  useAgentMemoryStore.getState().reset();
  readImpl = async () => ({
    global: [entry({ id: 'g1', title: 'About user' })],
    project: [entry({ id: 'p1', title: 'About project' })],
    globalFailed: false,
    projectFailed: false,
  });
  deleteImpl = async () => undefined;
  updateImpl = async (memoryId, patch) => ({ ...entry({ id: memoryId }), ...patch });
  lastPatch = null;
});

afterEach(() => {
  useAgentMemoryStore.getState().reset();
});

describe('load', () => {
  test('holds both scopes', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');

    const state = useAgentMemoryStore.getState();
    expect(state.global.map((item) => item.id)).toEqual(['g1']);
    expect(state.project.map((item) => item.id)).toEqual(['p1']);
    expect(state.loaded).toBe(true);
  });

  test('a failed load keeps what was already held', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');
    readImpl = async () => { throw new Error('offline'); };

    await useAgentMemoryStore.getState().load('/tmp/project');

    const state = useAgentMemoryStore.getState();
    // Blanking here would read as the agent having forgotten everything.
    expect(state.global).toHaveLength(1);
    expect(state.error).toBe('offline');
  });

  test('a disabled feature clears the lists rather than reporting an error', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');
    readImpl = async () => { throw new AgentMemoryDisabledError(); };

    await useAgentMemoryStore.getState().load('/tmp/project');

    const state = useAgentMemoryStore.getState();
    expect(state.disabled).toBe(true);
    expect(state.global).toHaveLength(0);
    expect(state.error).toBeNull();
  });

  test('a partly failed read is recorded as failed, not as empty', async () => {
    readImpl = async () => ({ global: [], project: [], globalFailed: true, projectFailed: false });

    await useAgentMemoryStore.getState().load('/tmp/project');

    expect(useAgentMemoryStore.getState().globalFailed).toBe(true);
  });
});

describe('delete', () => {
  test('removes the entry', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');

    const ok = await useAgentMemoryStore.getState().deleteEntry('project', 'p1');

    expect(ok).toBe(true);
    expect(useAgentMemoryStore.getState().project).toHaveLength(0);
  });

  test('restores the entry when the delete fails', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');
    deleteImpl = async () => { throw new Error('offline'); };

    const ok = await useAgentMemoryStore.getState().deleteEntry('project', 'p1');

    expect(ok).toBe(false);
    expect(useAgentMemoryStore.getState().project).toHaveLength(1);
  });
});


describe('user corrections', () => {
  test('sends only what changed and adopts the saved entry', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');

    const ok = await useAgentMemoryStore.getState().saveEntry('project', 'p1', { body: 'Reworded.' });

    expect(ok).toBe(true);
    expect(lastPatch).toEqual({ body: 'Reworded.' });
    expect(useAgentMemoryStore.getState().project[0].body).toBe('Reworded.');
  });

  test('a failed save leaves the entry as it was', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');
    updateImpl = async () => { throw new Error('offline'); };

    const ok = await useAgentMemoryStore.getState().saveEntry('project', 'p1', { body: 'Reworded.' });

    expect(ok).toBe(false);
    expect(useAgentMemoryStore.getState().project[0].body).toBe('Tests run with bun test.');
    expect(useAgentMemoryStore.getState().error).toBe('offline');
  });

  test('touches only the scope it was given', async () => {
    await useAgentMemoryStore.getState().load('/tmp/project');

    await useAgentMemoryStore.getState().saveEntry('project', 'p1', { title: 'Clearer' });

    expect(useAgentMemoryStore.getState().global[0].title).toBe('About user');
  });
});

describe('turning the feature off and on', () => {
  test('a successful load clears the disabled flag', async () => {
    readImpl = async () => { throw new AgentMemoryDisabledError(); };
    await useAgentMemoryStore.getState().load('/tmp/project');
    expect(useAgentMemoryStore.getState().disabled).toBe(true);

    readImpl = async () => ({
      global: [entry({ id: 'g1' })], project: [], globalFailed: false, projectFailed: false,
    });
    await useAgentMemoryStore.getState().load('/tmp/project');

    expect(useAgentMemoryStore.getState().disabled).toBe(false);
  });

  test('refresh re-reads the store the last load used', async () => {
    readImpl = async () => { throw new AgentMemoryDisabledError(); };
    await useAgentMemoryStore.getState().load('/tmp/project');

    let requestedPath: string | null = 'unset';
    readImpl = async () => {
      requestedPath = useAgentMemoryStore.getState().projectPath;
      return { global: [], project: [], globalFailed: false, projectFailed: false };
    };
    await useAgentMemoryStore.getState().refresh();

    // The disabled answer must not lose the path, or refresh reads the wrong store.
    expect(requestedPath).toBe('/tmp/project');
  });

  test('a stale disabled answer cannot latch the feature off again', async () => {
    // Re-enabling fires a load before the setting has finished being written,
    // so the server truthfully answers "disabled" to a request that is already
    // out of date by the time it lands.
    const gate: { release?: () => void } = {};
    readImpl = () => new Promise((_resolve, reject) => {
      gate.release = () => reject(new AgentMemoryDisabledError());
    });
    const stale = useAgentMemoryStore.getState().load('/tmp/project');

    readImpl = async () => ({
      global: [entry({ id: 'g1' })], project: [], globalFailed: false, projectFailed: false,
    });
    await useAgentMemoryStore.getState().load('/tmp/project');

    gate.release?.();
    await stale;

    expect(useAgentMemoryStore.getState().disabled).toBe(false);
    expect(useAgentMemoryStore.getState().global).toHaveLength(1);
  });
});
