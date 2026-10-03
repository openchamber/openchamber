import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createProjectIdFromPath } from './projectId';

const project = { id: 'openchamber', path: '/workspace/openchamber' };
const endpoint = `/api/projects/${encodeURIComponent(createProjectIdFromPath(project.path))}/config`;

const emptyPersonal = {
  setupWorktree: [],
  setupWorktreeWait: null,
  setupWorktreeMode: 'append',
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  hiddenSharedActionIds: [],
  sharedTrust: null,
};

const emptyShared = {
  status: 'missing',
  path: '.openchamber/project.json',
  setupWorktree: [],
  setupWorktreeWait: null,
  projectActions: [],
  draftStarters: [],
  plansDir: null,
};

// A minimal stand-in for the server: one personal document per project, the
// PUT merges the patch and echoes the merged view back like the real route.
let stored: Record<string, unknown> = { ...emptyPersonal };
let sharedOverride: Record<string, unknown> | null = null;
let viewOverride: Record<string, unknown> | null = null;

const viewOf = (): Record<string, unknown> => {
  if (viewOverride) return viewOverride;
  const personal = { ...emptyPersonal, ...stored };
  const shared = { ...emptyShared, ...(sharedOverride ?? {}) };
  const actions = personal.projectActions as Array<Record<string, unknown>>;
  // The real server sanitizes starters before merging; the stand-in does the same.
  const starters = (personal.draftStarters as Array<Record<string, unknown>>)
    .filter((starter) => starter.type === 'command' || starter.type === 'skill');
  return {
    trust: { hash: null, trusted: true },
    setupWorktree: [...(shared.setupWorktree as string[]), ...(personal.setupWorktree as string[])],
    setupWorktreeWait: personal.setupWorktreeWait ?? shared.setupWorktreeWait ?? false,
    projectActions: [
      ...(shared.projectActions as Array<Record<string, unknown>>).map((action) => ({ ...action, source: 'shared' })),
      ...actions.map((action) => ({ ...action, source: 'personal' })),
    ],
    projectActionsPrimaryId: personal.projectActionsPrimaryId,
    draftStarters: [
      ...(shared.draftStarters as Array<Record<string, unknown>>).map((starter) => ({ ...starter, source: 'shared' })),
      ...starters.map((starter) => ({ ...starter, source: 'personal' })),
    ],
    shared,
    personal,
  };
};
let requests: Array<{ url: string; method: string; body: unknown }> = [];
let failWith: number | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url, method, body });
    if (failWith !== null) {
      return new Response(JSON.stringify({ error: 'nope' }), { status: failWith });
    }
    if (method === 'PUT' && url.endsWith('/shared')) {
      sharedOverride = { ...(sharedOverride ?? {}), status: 'ok', ...(body as Record<string, unknown>) };
    } else if (method === 'PUT') {
      const patch = { ...(body as Record<string, unknown>) };
      delete patch.projectPath;
      stored = { ...stored, ...patch };
    }
    return new Response(JSON.stringify(viewOf()), { headers: { 'Content-Type': 'application/json' } });
  }),
}));

const {
  getProjectActionsState,
  getProjectDraftStarters,
  getProjectSetup,
  getWorktreeSetupCommands,
  getWorktreeSetupWaitEnabled,
  saveProjectActionsState,
  saveWorktreeSetupCommands,
  updateSharedProjectSetup,
} = await import('./openchamberConfig');

describe('project config client', () => {
  beforeEach(() => {
    stored = { ...emptyPersonal };
    sharedOverride = null;
    viewOverride = null;
    requests = [];
    failWith = null;
  });

  test('reads and writes through the project config route, never a file path', async () => {
    const saved = await saveProjectActionsState(project, {
      actions: [{ id: 'action-1', name: 'Run action', command: 'pnpm dev', runIn: 'parent' }],
      primaryActionId: 'action-1',
    });
    expect(saved).toBe(true);
    expect(requests[0]).toEqual({
      url: endpoint,
      method: 'PUT',
      body: {
        projectActions: [{ id: 'action-1', name: 'Run action', command: 'pnpm dev', runIn: 'parent' }],
        projectActionsPrimaryId: 'action-1',
        projectPath: project.path,
      },
    });

    const state = await getProjectActionsState(project);
    expect(state).toEqual({
      actions: [{ id: 'action-1', name: 'Run action', command: 'pnpm dev', runIn: 'parent', source: 'personal' }],
      primaryActionId: 'action-1',
    });
    expect(requests[1]).toEqual({ url: endpoint, method: 'GET', body: null });
  });

  test('exposes the merged view with the shared and personal blocks', async () => {
    stored = { ...emptyPersonal, setupWorktree: ['cp .env.example .env'], draftStarters: [{ type: 'command', name: 'mine' }] };
    sharedOverride = { status: 'ok', setupWorktree: ['bun install'], setupWorktreeWait: true, plansDir: 'docs/plans', draftStarters: [{ type: 'skill', name: 'triage-prs' }] };
    const setup = await getProjectSetup(project);
    expect(setup.setupWorktree).toEqual(['bun install', 'cp .env.example .env']);
    expect(setup.setupWorktreeWait).toBe(true);
    expect(setup.shared.status).toBe('ok');
    expect(setup.shared.plansDir).toBe('docs/plans');
    expect(setup.personal.setupWorktree).toEqual(['cp .env.example .env']);
    expect(await getProjectDraftStarters(project)).toEqual([
      { type: 'skill', name: 'triage-prs', source: 'shared' },
      { type: 'command', name: 'mine', source: 'personal' },
    ]);
  });

  test('never sends the source mark back when saving actions', async () => {
    await saveProjectActionsState(project, {
      actions: [{ id: 'a', name: 'A', command: 'x', source: 'personal' }],
      primaryActionId: null,
    });
    expect(requests[0].body).toEqual({
      projectActions: [{ id: 'a', name: 'A', command: 'x' }],
      projectActionsPrimaryId: null,
      projectPath: project.path,
    });
  });

  test('drops empty setup commands before sending', async () => {
    await saveWorktreeSetupCommands(project, ['bun install', '', '  ']);
    expect(requests[0].body).toEqual({ setupWorktree: ['bun install'], projectPath: project.path });
    expect(await getWorktreeSetupCommands(project)).toEqual(['bun install']);
  });

  test('parses the personal starters defensively from the response', async () => {
    stored = { ...emptyPersonal, draftStarters: [{ type: 'skill', name: 'triage-prs' }, { type: 'bogus', name: 'x' }] };
    expect((await getProjectSetup(project)).personal.draftStarters).toEqual([{ type: 'skill', name: 'triage-prs' }]);
  });

  test('writes the shared file through its own route without source marks and returns the view', async () => {
    const view = await updateSharedProjectSetup(project, {
      projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'personal' }],
      plansDir: 'docs/plans',
    });
    expect(requests[0]).toEqual({
      url: `${endpoint}/shared`,
      method: 'PUT',
      body: { projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }], plansDir: 'docs/plans' },
    });
    expect(view?.shared.plansDir).toBe('docs/plans');
    expect(view?.projectActions).toEqual([{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'shared' }]);
    failWith = 500;
    expect(await updateSharedProjectSetup(project, { plansDir: null })).toBeNull();
  });

  test('a failed read resolves to the empty value and a failed write to false', async () => {
    failWith = 500;
    expect(await getWorktreeSetupCommands(project)).toEqual([]);
    expect(await getWorktreeSetupWaitEnabled(project)).toBe(false);
    expect(await getProjectActionsState(project)).toEqual({ actions: [], primaryActionId: null });
    expect(await saveWorktreeSetupCommands(project, ['x'])).toBe(false);
  });

  test('a response with an unexpected shape is not trusted', async () => {
    viewOverride = { setupWorktree: 'bun install' };
    expect(await getWorktreeSetupCommands(project)).toEqual([]);
  });

  test('a project without a path never hits the network', async () => {
    expect(await getWorktreeSetupCommands({ id: 'x', path: '' })).toEqual([]);
    expect(await saveWorktreeSetupCommands({ id: 'x', path: '' }, ['x'])).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
