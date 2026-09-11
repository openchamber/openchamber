import { beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgentMemoryActions } from './actions.js';
import { createAgentMemoryRuntime } from './runtime.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

const DIRECTORY = '/tmp/some-project';

class TestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let actions;
let runtime;

beforeEach(async () => {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-memory-actions-'));
  runtime = createAgentMemoryRuntime({
    fsPromises,
    path,
    userConfigRoot: path.join(rootDir, 'config'),
    projectsDirPath: path.join(rootDir, 'config', 'projects'),
  });
  actions = createAgentMemoryActions({
    agentMemoryRuntime: runtime,
    createError: (message, status) => new TestError(message, status),
    resolveProjectId: async (directory) => createProjectIdFromPath(directory),
  });
});

describe('scope', () => {
  test('project scope files against the session directory, not a model-supplied id', async () => {
    await actions.execute('memory.save', {
      scope: 'project',
      title: 'Uses bun',
      body: 'Tests run with bun test.',
      projectId: 'path_somewhere_else',
    }, DIRECTORY);

    const stored = await runtime.read({
      scope: 'project',
      projectId: createProjectIdFromPath(DIRECTORY),
    });
    expect(stored.entries.map((entry) => entry.title)).toEqual(['Uses bun']);
  });

  test('project scope without a session directory fails instead of writing global', async () => {
    await expect(actions.execute('memory.save', { scope: 'project', title: 'T', body: 'b' }, null))
      .rejects.toThrow('needs a session directory');
    expect((await runtime.read({ scope: 'global' })).entries).toHaveLength(0);
  });

  test('an unknown scope is rejected', async () => {
    await expect(actions.execute('memory.save', { scope: 'team', title: 'T', body: 'b' }, DIRECTORY))
      .rejects.toThrow('scope must be global or project');
  });

  test('an unknown action is rejected', async () => {
    await expect(actions.execute('memory.forget', {}, DIRECTORY)).rejects.toThrow('Unsupported memory action');
  });
});

describe('save', () => {
  test('requires title and body', async () => {
    await expect(actions.execute('memory.save', { scope: 'global', body: 'b' }, DIRECTORY))
      .rejects.toThrow('title is required');
    await expect(actions.execute('memory.save', { scope: 'global', title: 't' }, DIRECTORY))
      .rejects.toThrow('body is required');
  });

  test('rejects an unknown type', async () => {
    await expect(actions.execute('memory.save', {
      scope: 'global', title: 't', body: 'b', type: 'nonsense',
    }, DIRECTORY)).rejects.toThrow('type must be');
  });

  test('reports a correction as replaced so the agent does not claim a second memory', async () => {
    await actions.execute('memory.save', {
      scope: 'global',
      title: 'Prefers Ukrainian replies',
      body: 'The user wants answers written in Ukrainian.',
    }, DIRECTORY);

    const result = await actions.execute('memory.save', {
      scope: 'global',
      title: 'Answers should be in Ukrainian',
      body: 'The user wants replies written in Ukrainian.',
    }, DIRECTORY);

    expect(result.replaced).toBe(true);
    expect((await runtime.read({ scope: 'global' })).entries).toHaveLength(1);
  });

  test('announces the write so an open panel can show it', async () => {
    const seen = [];
    const announcing = createAgentMemoryActions({
      agentMemoryRuntime: runtime,
      createError: (message, status) => new TestError(message, status),
      resolveProjectId: async (directory) => createProjectIdFromPath(directory),
      onMemoryChanged: (event) => seen.push(event),
    });

    await announcing.execute('memory.save', { scope: 'project', title: 'T', body: 'b' }, DIRECTORY);

    expect(seen).toEqual([{ scope: 'project', projectId: createProjectIdFromPath(DIRECTORY) }]);
  });

  test('a broken listener does not fail the write', async () => {
    const announcing = createAgentMemoryActions({
      agentMemoryRuntime: runtime,
      createError: (message, status) => new TestError(message, status),
      resolveProjectId: async (directory) => createProjectIdFromPath(directory),
      onMemoryChanged: () => { throw new Error('listener exploded'); },
    });

    const result = await announcing.execute('memory.save', { scope: 'global', title: 'T', body: 'b' }, DIRECTORY);

    // The memory is already on disk; a broken notification must not report it
    // back as a failure.
    expect(result.memory.title).toBe('T');
  });
});

describe('worktree sessions reach the project store', () => {
  test('every memory action resolves the directory through the project resolver', async () => {
    const WORKTREE = '/tmp/worktree-checkout';
    const worktreeAware = createAgentMemoryActions({
      agentMemoryRuntime: runtime,
      createError: (message, status) => new TestError(message, status),
      // A worktree session must land in the project's store, not one keyed by
      // the worktree path that the panel never reads.
      resolveProjectId: async () => createProjectIdFromPath(DIRECTORY),
    });

    const saved = await worktreeAware.execute('memory.save', {
      scope: 'project', title: 'Learned in a worktree', body: 'Body.',
    }, WORKTREE);

    expect((await runtime.read({ scope: 'project', projectId: createProjectIdFromPath(DIRECTORY) })).entries)
      .toHaveLength(1);

    // Reading and listing must agree with the write, or the agent would store
    // something it can never find again.
    const read = await worktreeAware.execute('memory.read', {
      scope: 'project', memoryId: saved.memory.memoryId,
    }, WORKTREE);
    expect(read.memory.body).toBe('Body.');

    const listed = await worktreeAware.execute('memory.list', {}, WORKTREE);
    expect(listed.memories.map((memory) => memory.title)).toEqual(['Learned in a worktree']);

    await worktreeAware.execute('memory.delete', {
      scope: 'project', memoryId: saved.memory.memoryId,
    }, WORKTREE);
    expect((await runtime.read({ scope: 'project', projectId: createProjectIdFromPath(DIRECTORY) })).entries)
      .toHaveLength(0);
  });
});

describe('read', () => {
  test('reads by the title the session index shows', async () => {
    await actions.execute('memory.save', { scope: 'global', title: 'Uses bun', body: 'Full text here.' }, DIRECTORY);

    const result = await actions.execute('memory.read', { scope: 'global', title: 'uses BUN' }, DIRECTORY);

    expect(result.memory.body).toBe('Full text here.');
  });

  test('reads by id', async () => {
    const saved = await actions.execute('memory.save', { scope: 'global', title: 'T', body: 'Full text.' }, DIRECTORY);

    const result = await actions.execute('memory.read', {
      scope: 'global', memoryId: saved.memory.memoryId,
    }, DIRECTORY);

    expect(result.memory.body).toBe('Full text.');
  });

  test('requires something to look up', async () => {
    await expect(actions.execute('memory.read', { scope: 'global' }, DIRECTORY))
      .rejects.toThrow('requires memoryId or title');
  });

  test('a miss is reported, not answered with an empty memory', async () => {
    await expect(actions.execute('memory.read', { scope: 'global', title: 'absent' }, DIRECTORY))
      .rejects.toThrow('No memory matches');
  });

  test('finds a memory without being told which store holds it', async () => {
    // Scope decides everything for a write, but for a read it is only which
    // drawer to open — demanding it turned a legible request into an error.
    await actions.execute('memory.save', { scope: 'global', title: 'About user', body: 'Global text.' }, DIRECTORY);

    const result = await actions.execute('memory.read', { title: 'About user' }, DIRECTORY);

    expect(result.memory.body).toBe('Global text.');
    expect(result.memory.scope).toBe('global');
  });

  test('prefers the project store when both hold the same title', async () => {
    await actions.execute('memory.save', { scope: 'global', title: 'Shared', body: 'Global text.' }, DIRECTORY);
    await actions.execute('memory.save', { scope: 'project', title: 'Shared', body: 'Project text.' }, DIRECTORY);

    const result = await actions.execute('memory.read', { title: 'Shared' }, DIRECTORY);

    expect(result.memory.scope).toBe('project');
  });

  test('an unscoped miss is still reported', async () => {
    await expect(actions.execute('memory.read', { title: 'absent' }, DIRECTORY))
      .rejects.toThrow('No memory matches');
  });

  test('a store that failed to load is not reported as an absent memory', async () => {
    const failing = createAgentMemoryActions({
      agentMemoryRuntime: {
        readAll: async () => ({ global: [], project: [], globalFailed: true, projectFailed: false }),
      },
      createError: (message, status) => new TestError(message, status),
      resolveProjectId: async (directory) => createProjectIdFromPath(directory),
    });

    // Answering "no such memory" would send the agent off to store it again.
    await expect(failing.execute('memory.read', { title: 'anything' }, DIRECTORY))
      .rejects.toThrow('could not be read');
  });

  test('does not reach across scopes', async () => {
    await actions.execute('memory.save', { scope: 'project', title: 'Uses bun', body: 'x' }, DIRECTORY);

    await expect(actions.execute('memory.read', { scope: 'global', title: 'Uses bun' }, DIRECTORY))
      .rejects.toThrow('No memory matches');
  });
});

describe('list', () => {
  test('lists both scopes by default and labels which is which', async () => {
    await actions.execute('memory.save', { scope: 'global', title: 'About user', body: 'x' }, DIRECTORY);
    await actions.execute('memory.save', { scope: 'project', title: 'About project', body: 'y' }, DIRECTORY);

    const result = await actions.execute('memory.list', {}, DIRECTORY);

    expect(result.memories.map((memory) => [memory.title, memory.scope])).toEqual([
      ['About user', 'global'],
      ['About project', 'project'],
    ]);
  });

  test('listing never carries bodies', async () => {
    await actions.execute('memory.save', { scope: 'global', title: 'T', body: 'Long body text.' }, DIRECTORY);

    const result = await actions.execute('memory.list', { scope: 'global' }, DIRECTORY);

    expect(result.memories[0].body).toBeUndefined();
  });

  test('a broken scope is reported rather than shown as empty', async () => {
    const failing = createAgentMemoryActions({
      agentMemoryRuntime: {
        readAll: async () => ({ global: [], project: [], globalFailed: true, projectFailed: false }),
      },
      createError: (message, status) => new TestError(message, status),
      resolveProjectId: async (directory) => createProjectIdFromPath(directory),
    });

    const result = await failing.execute('memory.list', {}, DIRECTORY);

    expect(result.globalUnavailable).toBe(true);
  });
});

describe('delete', () => {
  test('removes the entry', async () => {
    const saved = await actions.execute('memory.save', { scope: 'global', title: 'T', body: 'b' }, DIRECTORY);

    await actions.execute('memory.delete', { scope: 'global', memoryId: saved.memory.memoryId }, DIRECTORY);

    expect((await runtime.read({ scope: 'global' })).entries).toHaveLength(0);
  });

  test('requires an id', async () => {
    await expect(actions.execute('memory.delete', { scope: 'global' }, DIRECTORY))
      .rejects.toThrow('memoryId is required');
  });

  test('reports a miss instead of claiming success', async () => {
    await expect(actions.execute('memory.delete', { scope: 'global', memoryId: 'absent' }, DIRECTORY))
      .rejects.toThrow('No memory has that id');
  });
});

describe('when the user switches memory off', () => {
  const disabled = () => createAgentMemoryActions({
    agentMemoryRuntime: runtime,
    createError: (message, status) => new TestError(message, status),
    resolveProjectId: async (directory) => createProjectIdFromPath(directory),
    isAgentMemoryEnabled: async () => false,
  });

  test('refuses to write, so nothing accumulates unseen', async () => {
    // The tool lives in the OpenCode child until it restarts, so the agent can
    // still call this after the switch goes off. Those writes would land on
    // disk while the panel showing them is hidden.
    await expect(disabled().execute('memory.save', { scope: 'global', title: 'T', body: 'b' }, DIRECTORY))
      .rejects.toThrow('switched off');
    expect((await runtime.read({ scope: 'global' })).entries).toHaveLength(0);
  });

  test('refuses to read as well', async () => {
    await expect(disabled().execute('memory.list', {}, DIRECTORY)).rejects.toThrow('switched off');
    await expect(disabled().execute('memory.read', { title: 'x' }, DIRECTORY)).rejects.toThrow('switched off');
  });

  test('an unreadable setting closes the surface rather than opening it', async () => {
    const unknown = createAgentMemoryActions({
      agentMemoryRuntime: runtime,
      createError: (message, status) => new TestError(message, status),
      resolveProjectId: async (directory) => createProjectIdFromPath(directory),
      isAgentMemoryEnabled: async () => { throw new Error('settings unreadable'); },
    });

    await expect(unknown.execute('memory.save', { scope: 'global', title: 'T', body: 'b' }, DIRECTORY))
      .rejects.toThrow('switched off');
  });

  test('works normally while it is on', async () => {
    const on = createAgentMemoryActions({
      agentMemoryRuntime: runtime,
      createError: (message, status) => new TestError(message, status),
      resolveProjectId: async (directory) => createProjectIdFromPath(directory),
      isAgentMemoryEnabled: async () => true,
    });

    const result = await on.execute('memory.save', { scope: 'global', title: 'T', body: 'b' }, DIRECTORY);
    expect(result.saved).toBe(true);
  });
});
