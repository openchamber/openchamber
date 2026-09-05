import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createProjectIdFromPath } from './projectId';

const homeDirectory = '/Users/test';
const project = { id: 'openchamber', path: '/workspace/openchamber' };

let files = new Map<string, string>();

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => ({
    files: {
      createDirectory: mock(async () => ({ success: true })),
      readFile: mock(async (path: string) => ({ content: files.get(path) ?? '' })),
      writeFile: mock(async (path: string, content: string) => {
        files.set(path, content);
        return { success: true };
      }),
      delete: mock(async (path: string) => {
        files.delete(path);
      }),
    },
  })),
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: mock(async () => homeDirectory),
  isVSCodeRuntime: mock(() => false),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string) => {
    if (url.endsWith('/fs/home')) {
      return new Response(JSON.stringify({ home: homeDirectory }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

const {
  getProjectActionsState,
  saveProjectActionsState,
} = await import('./openchamberConfig');

const getConfigPath = (projectPath: string): string => (
  `${homeDirectory}/.config/openchamber/projects/${createProjectIdFromPath(projectPath)}.json`
);

describe('project actions config sanitization', () => {
  beforeEach(() => {
    files = new Map();
  });

  test('round-trips runIn parent through saved project actions state', async () => {
    const saved = await saveProjectActionsState(project, {
      actions: [{
        id: 'action-1',
        name: 'Run action',
        command: 'pnpm dev',
        runIn: 'parent',
      }],
      primaryActionId: 'action-1',
    });

    expect(saved).toBe(true);

    const state = await getProjectActionsState(project);

    expect(state).toEqual({
      actions: [{
        id: 'action-1',
        name: 'Run action',
        command: 'pnpm dev',
        icon: null,
        runIn: 'parent',
      }],
      primaryActionId: 'action-1',
    });
  });

  test('keeps runIn omitted when saving project actions in the current worktree', async () => {
    const saved = await saveProjectActionsState(project, {
      actions: [{
        id: 'action-1',
        name: 'Run action',
        command: 'pnpm dev',
      }],
      primaryActionId: 'action-1',
    });

    expect(saved).toBe(true);

    const state = await getProjectActionsState(project);

    expect(state).toEqual({
      actions: [{
        id: 'action-1',
        name: 'Run action',
        command: 'pnpm dev',
        icon: null,
      }],
      primaryActionId: 'action-1',
    });
  });

  test('normalizes runIn worktree to omission when loading project actions state', async () => {
    files.set(getConfigPath(project.path), JSON.stringify({
      projectPath: project.path,
      projectActions: [
        { id: 'action-1', name: 'Run action', command: 'pnpm dev', runIn: 'worktree' },
      ],
      projectActionsPrimaryId: 'action-1',
    }));

    const state = await getProjectActionsState(project);

    expect(state).toEqual({
      actions: [
        { id: 'action-1', name: 'Run action', command: 'pnpm dev', icon: null },
      ],
      primaryActionId: 'action-1',
    });
  });

  test('omits unsupported runIn values when loading project actions state', async () => {
    files.set(getConfigPath(project.path), JSON.stringify({
      projectPath: project.path,
      projectActions: [
        { id: 'action-project', name: 'Project', command: 'pnpm dev', runIn: 'project' },
        { id: 'action-number', name: 'Number', command: 'pnpm test', runIn: 123 },
      ],
      projectActionsPrimaryId: 'action-project',
    }));

    const state = await getProjectActionsState(project);

    expect(state).toEqual({
      actions: [
        { id: 'action-project', name: 'Project', command: 'pnpm dev', icon: null },
        { id: 'action-number', name: 'Number', command: 'pnpm test', icon: null },
      ],
      primaryActionId: 'action-project',
    });
  });
});
