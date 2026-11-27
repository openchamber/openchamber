import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFoldersStore } from '../session-folders/store.js';
import { createOpenChamberControlService } from './service.js';

const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-control-folders-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsPromises.rm(dir, { recursive: true, force: true })));
});

const DEFAULT_PROJECT_ROOT = '/repo/athena';
const DEFAULT_OTHER_PROJECT_ROOT = '/repo/other';
const DEFAULT_CHATS_ROOT = '/data/chats';

const createHarness = async (options = {}) => {
  const dataDir = await makeTempDir();
  const changedRevisions = [];
  let clock = 1_000;
  const sessionFoldersStore = createSessionFoldersStore({
    fsPromises,
    path,
    openchamberDataDir: dataDir,
    onChanged: (updatedAt) => changedRevisions.push(updatedAt),
    now: () => {
      clock += 10;
      return clock;
    },
  });

  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const otherProjectRoot = options.otherProjectRoot ?? DEFAULT_OTHER_PROJECT_ROOT;
  const chatsRoot = options.chatsRoot ?? DEFAULT_CHATS_ROOT;
  const worktreeRoots = new Map(Object.entries(options.worktreeRoots ?? {}));
  const sessionDirs = new Map(Object.entries(options.sessionDirs ?? {}));

  const createSpy = vi.fn(async (payload) => {
    const worktreeName = payload.worktree?.name;
    if (worktreeName) {
      const worktreePath = `/worktrees/${worktreeName}`;
      return {
        sessionId: `ses_${worktreeName}`,
        directory: worktreePath,
        worktree: { path: worktreePath, branch: worktreeName },
        promptDispatched: Boolean(payload.prompt),
      };
    }
    return {
      sessionId: 'ses_created',
      directory: payload.directory || projectRoot,
      promptDispatched: Boolean(payload.prompt),
    };
  });

  const moveToWorktreeSpy = vi.fn(async (sessionId, payload) => {
    const worktreePath = `/worktrees/${payload.worktree.name}`;
    return {
      sessionId,
      directory: worktreePath,
      worktree: { path: worktreePath, branch: payload.worktree.name },
    };
  });

  const sessionService = {
    create: createSpy,
    send: vi.fn(async (sessionId) => ({ sessionId, directory: projectRoot, promptDispatched: true })),
    fork: vi.fn(async (sessionId) => ({ sessionId: `${sessionId}_fork`, directory: projectRoot, promptDispatched: false })),
    moveToWorktree: moveToWorktreeSpy,
    resolveDirectory: vi.fn(async ({ projectId, directory }) => {
      if (projectId === 'proj-athena') return projectRoot;
      if (projectId === 'proj-other') return otherProjectRoot;
      if (projectId === 'openchamber:chats') return chatsRoot;
      return directory || projectRoot;
    }),
    projectPathFor: vi.fn(async (directory) => {
      if (directory.startsWith('/worktrees/')) return projectRoot;
      if (directory.startsWith(otherProjectRoot)) return otherProjectRoot;
      if (directory.startsWith(chatsRoot)) return chatsRoot;
      return projectRoot;
    }),
  };

  const client = {
    session: {
      get: vi.fn(async ({ sessionID }) => {
        const dir = sessionDirs.get(sessionID);
        return dir ? { id: sessionID, location: { directory: dir } } : null;
      }),
      list: vi.fn(async () => ({ data: [] })),
    },
  };

  const service = createOpenChamberControlService({
    readSettingsFromDiskMigrated: async () => ({
      projects: [
        { id: 'proj-athena', path: projectRoot, label: 'Athena' },
        { id: 'proj-other', path: otherProjectRoot, label: 'Other' },
      ],
    }),
    sanitizeProjects: (projects) => projects,
    chatsScope: { root: chatsRoot },
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    sessionService,
    scheduledTaskService: { status: async () => ({}), resolveProjectID: async () => 'proj-athena', list: async () => [] },
    createClient: () => client,
    sessionFoldersStore,
    resolveWorktreeRoot: async (directory) => {
      if (worktreeRoots.has(directory)) return worktreeRoots.get(directory);
      if (directory.startsWith('/worktrees/')) {
        const parts = directory.split('/');
        return `/${parts[1]}/${parts[2]}`;
      }
      if (directory.startsWith(`${projectRoot}/`)) return projectRoot;
      return null;
    },
  });

  return {
    service,
    sessionFoldersStore,
    changedRevisions,
    createSpy,
    moveToWorktreeSpy,
    projectRoot,
    otherProjectRoot,
    chatsRoot,
  };
};

describe('openchamber control sidebar folders', () => {
  it('lists, creates (idempotently with nesting), and moves worktrees and sessions', async () => {
    const { service, changedRevisions, projectRoot } = await createHarness({
      sessionDirs: {
        ses_wt: '/worktrees/reorder-endpoint-schemas/packages/api',
        ses_root: `${DEFAULT_PROJECT_ROOT}/src`,
      },
    });

    const empty = await service.execute('folder.list', {}, projectRoot, { contextSessionId: 'ses_root' });
    expect(empty).toEqual({ scopeKey: projectRoot, folders: [], currentFolder: null });

    const created = await service.execute('folder.create', { name: 'AI rules' }, projectRoot);
    expect(created.created).toBe(true);
    expect(created.folder).toMatchObject({ name: 'AI rules', parentId: null });
    expect(changedRevisions).toHaveLength(1);

    // Same name under same parent is idempotent.
    const duplicate = await service.execute('folder.create', { name: '  ai rules  ' }, projectRoot);
    expect(duplicate).toEqual({ scopeKey: projectRoot, folder: created.folder, created: false });
    expect(changedRevisions).toHaveLength(1);

    const nested = await service.execute('folder.create', { name: 'Schemas', parentId: created.folder.id }, projectRoot);
    expect(nested.created).toBe(true);
    expect(nested.folder.parentId).toBe(created.folder.id);

    // Moving from inside a worktree subdirectory targets the worktree root.
    const movedWorktree = await service.execute(
      'folder.move',
      { folder: 'ai rules' },
      '/worktrees/reorder-endpoint-schemas/packages/api',
      { contextSessionId: 'ses_wt' },
    );
    expect(movedWorktree).toEqual({
      scopeKey: projectRoot,
      target: {
        kind: 'worktree',
        memberId: 'worktree:/worktrees/reorder-endpoint-schemas',
        directory: '/worktrees/reorder-endpoint-schemas',
      },
      folder: { id: created.folder.id, name: 'AI rules' },
      moved: true,
    });

    // Listing from that worktree reports currentFolder.
    const listedFromWorktree = await service.execute(
      'folder.list',
      {},
      '/worktrees/reorder-endpoint-schemas/packages/api',
      { contextSessionId: 'ses_wt' },
    );
    expect(listedFromWorktree.currentFolder).toEqual({ id: created.folder.id, name: 'AI rules' });
    expect(listedFromWorktree.folders).toEqual([
      { id: created.folder.id, name: 'AI rules', parentId: null, memberCount: 1 },
      { id: nested.folder.id, name: 'Schemas', parentId: created.folder.id, memberCount: 0 },
    ]);

    // Moving from a project root subdirectory targets the sessionId (not a worktree).
    const movedSession = await service.execute(
      'folder.move',
      { folder: nested.folder.id },
      `${projectRoot}/src`,
      { contextSessionId: 'ses_root' },
    );
    expect(movedSession.target).toEqual({
      kind: 'session',
      memberId: 'ses_root',
      sessionId: 'ses_root',
    });

    // folder: null removes the worktree from its folder.
    const unfiled = await service.execute(
      'folder.move',
      { folder: null },
      '/worktrees/reorder-endpoint-schemas',
      { contextSessionId: 'ses_wt' },
    );
    expect(unfiled.folder).toBeNull();
    expect(unfiled.moved).toBe(true);
  });

  it('rejects ambiguous folder names, missing parentId, and missing folder parameter, and auto-creates a missing folder name on move', async () => {
    const { service, projectRoot } = await createHarness();
    const parent = await service.execute('folder.create', { name: 'Parent' }, projectRoot);
    await service.execute('folder.create', { name: 'Work' }, projectRoot);
    await service.execute('folder.create', { name: 'Work', parentId: parent.folder.id }, projectRoot);

    await expect(service.execute('folder.move', {}, projectRoot, { contextSessionId: 'ses_1' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.execute('folder.move', { folder: 'Work' }, projectRoot, { contextSessionId: 'ses_1' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Multiple sidebar folders match') });
    await expect(service.execute('folder.create', { name: 'Bad', parentId: 'no-such-parent' }, projectRoot))
      .rejects.toMatchObject({ statusCode: 404 });

    const autoCreated = await service.execute('folder.move', { folder: 'Brand New' }, projectRoot, { contextSessionId: 'ses_1' });
    expect(autoCreated.folder).toMatchObject({ name: 'Brand New' });
    expect(autoCreated.moved).toBe(true);
  });

  it('auto-inherits the caller folder on session.create with worktree, supports explicit override and null opt-out', async () => {
    const { service, sessionFoldersStore, createSpy, projectRoot } = await createHarness({
      sessionDirs: { ses_lead: DEFAULT_PROJECT_ROOT },
    });

    const folder = await service.execute('folder.create', { name: 'AI rules' }, projectRoot);
    await service.execute('folder.move', { folder: folder.folder.id, sessionId: 'ses_lead' }, projectRoot);

    // Lead spawns an ownWork worktree without passing folder -> inherits "AI rules".
    const inherited = await service.execute(
      'session.create',
      { worktree: 'stream-a', ownWork: true },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(inherited.folder).toEqual({ id: folder.folder.id, name: 'AI rules' });

    // Opt out with folder: null -> unfiled.
    const unfiled = await service.execute(
      'session.create',
      { worktree: 'stream-b', ownWork: true, folder: null },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(unfiled.folder).toBeUndefined();

    // ownWork without a worktree nests under parent, so auto-inheritance does not file its sessionId.
    const nestedChild = await service.execute(
      'session.create',
      { ownWork: true },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(nestedChild.folder).toBeUndefined();

    // Creating in another project does not inherit caller's folder.
    const otherProj = await service.execute(
      'session.create',
      { projectId: 'proj-other', worktree: 'other-wt' },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(otherProj.folder).toBeUndefined();

    // Explicit new folder name on session.create auto-creates the folder and files the worktree.
    const withNewFolder = await service.execute(
      'session.create',
      { worktree: 'stream-c', folder: 'Fresh stream' },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(withNewFolder.folder).toMatchObject({ name: 'Fresh stream' });

    // Ambiguous duplicate folder name fails fast BEFORE creating the worktree/session.
    await service.execute('folder.create', { name: 'Dup' }, projectRoot);
    await service.execute('folder.create', { name: 'Dup', parentId: folder.folder.id }, projectRoot);
    const callsBefore = createSpy.mock.calls.length;
    await expect(
      service.execute('session.create', { worktree: 'stream-d', folder: 'Dup' }, projectRoot, { contextSessionId: 'ses_lead' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(createSpy).toHaveBeenCalledTimes(callsBefore);

    const snapshot = await sessionFoldersStore.readCurrent();
    expect(snapshot.foldersMap[projectRoot][0].sessionIds).toEqual([
      'ses_lead',
      'worktree:/worktrees/stream-a',
    ]);
    const fresh = snapshot.foldersMap[projectRoot].find((entry) => entry.name === 'Fresh stream');
    expect(fresh?.sessionIds).toEqual(['worktree:/worktrees/stream-c']);
  });

  it('inherits folder on session.moveToWorktree and unassigns the old root session id', async () => {
    const { service, sessionFoldersStore, moveToWorktreeSpy, projectRoot } = await createHarness({
      sessionDirs: { ses_root: DEFAULT_PROJECT_ROOT },
    });

    const folder = await service.execute('folder.create', { name: 'Stream' }, projectRoot);
    await service.execute('folder.move', { folder: folder.folder.id, sessionId: 'ses_root' }, projectRoot);

    const moved = await service.execute(
      'session.moveToWorktree',
      { worktree: 'fix-stream' },
      projectRoot,
      { contextSessionId: 'ses_root' },
    );
    expect(moved.folder).toEqual({ id: folder.folder.id, name: 'Stream' });

    const snapshot = await sessionFoldersStore.readCurrent();
    expect(snapshot.foldersMap[projectRoot][0].sessionIds).toEqual(['worktree:/worktrees/fix-stream']);

    // Explicit new folder name on session.moveToWorktree creates it and files the worktree.
    const movedToNew = await service.execute(
      'session.moveToWorktree',
      { worktree: 'fix-2', folder: 'New Stream' },
      projectRoot,
      { contextSessionId: 'ses_root' },
    );
    expect(movedToNew.folder).toMatchObject({ name: 'New Stream' });
    expect(moveToWorktreeSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects folder on session.send and session.fork', async () => {
    const { service, projectRoot } = await createHarness();
    await expect(service.execute('session.send', { sessionId: 'ses_1', prompt: 'hi', folder: 'AI rules' }, projectRoot))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.execute('session.fork', { sessionId: 'ses_1', folder: 'AI rules' }, projectRoot))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('uses shared Chats root for managed Chats and sessionId for nested projects inside a parent git repo', async () => {
    const nestedProject = '/monorepo/packages/app';
    const chatDir = `${DEFAULT_CHATS_ROOT}/2026-11-27/ses_chat`;
    const { service } = await createHarness({
      projectRoot: nestedProject,
      sessionDirs: {
        ses_chat: chatDir,
        ses_nested: nestedProject,
      },
      worktreeRoots: {
        [nestedProject]: '/monorepo',
      },
    });

    const chatFolder = await service.execute('folder.create', { name: 'Daily', projectId: 'openchamber:chats' }, nestedProject);
    const movedChat = await service.execute('folder.move', { folder: 'Daily' }, chatDir, { contextSessionId: 'ses_chat' });
    expect(movedChat).toMatchObject({
      scopeKey: DEFAULT_CHATS_ROOT,
      target: { kind: 'session', memberId: 'ses_chat', sessionId: 'ses_chat' },
      folder: { id: chatFolder.folder.id, name: 'Daily' },
    });

    const nestedFolder = await service.execute('folder.create', { name: 'App' }, nestedProject);
    const movedNested = await service.execute('folder.move', { folder: 'App' }, nestedProject, { contextSessionId: 'ses_nested' });
    expect(movedNested).toMatchObject({
      scopeKey: nestedProject,
      target: { kind: 'session', memberId: 'ses_nested', sessionId: 'ses_nested' },
      folder: { id: nestedFolder.folder.id, name: 'App' },
    });
  });

  it('rejects unresolved explicit sessionId and cross-project scope conflicts in folder.move', async () => {
    const { service, projectRoot } = await createHarness({
      sessionDirs: { ses_other: DEFAULT_OTHER_PROJECT_ROOT },
    });
    await service.execute('folder.create', { name: 'AI rules' }, projectRoot);

    await expect(service.execute('folder.move', { folder: 'AI rules', sessionId: 'ses_missing' }, projectRoot))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(service.execute('folder.move', { folder: 'AI rules', sessionId: 'ses_other', projectId: 'proj-athena' }, projectRoot))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('does not add a phantom sessionId when creating a session inside an existing filed worktree', async () => {
    const { service, sessionFoldersStore, projectRoot } = await createHarness({
      sessionDirs: { ses_in_wt: '/worktrees/existing-wt' },
    });
    const folder = await service.execute('folder.create', { name: 'AI rules' }, projectRoot);
    await service.execute('folder.move', { folder: folder.folder.id }, '/worktrees/existing-wt', { contextSessionId: 'ses_in_wt' });

    const created = await service.execute(
      'session.create',
      {},
      '/worktrees/existing-wt',
      { contextSessionId: 'ses_in_wt' },
    );
    expect(created.folder).toBeUndefined();
    const snapshot = await sessionFoldersStore.readCurrent();
    expect(snapshot.foldersMap[projectRoot][0].sessionIds).toEqual(['worktree:/worktrees/existing-wt']);
  });

  it('inherits caller folder when moving an unfiled sibling session to a worktree, and preserves created session if folder is deleted mid-flight', async () => {
    const { service, sessionFoldersStore, createSpy, projectRoot } = await createHarness({
      sessionDirs: { ses_lead: DEFAULT_PROJECT_ROOT, ses_sibling: DEFAULT_PROJECT_ROOT },
    });
    const folder = await service.execute('folder.create', { name: 'Stream' }, projectRoot);
    await service.execute('folder.move', { folder: folder.folder.id, sessionId: 'ses_lead' }, projectRoot);

    const movedSibling = await service.execute(
      'session.moveToWorktree',
      { sessionId: 'ses_sibling', worktree: 'sibling-wt' },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(movedSibling.folder).toEqual({ id: folder.folder.id, name: 'Stream' });

    // Delete the folder while session.create is in flight: created session is still returned, with folderError instead of bogus success.
    createSpy.mockImplementationOnce(async () => {
      await sessionFoldersStore.applyChanges([{ type: 'delete', scopeKey: projectRoot, folderIds: [folder.folder.id] }]);
      return {
        sessionId: 'ses_raced',
        directory: '/worktrees/raced-wt',
        worktree: { path: '/worktrees/raced-wt', branch: 'raced-wt' },
        promptDispatched: false,
      };
    });

    const raced = await service.execute(
      'session.create',
      { worktree: 'raced-wt', folder: folder.folder.id },
      projectRoot,
      { contextSessionId: 'ses_lead' },
    );
    expect(raced.sessionId).toBe('ses_raced');
    expect(raced.folder).toBeUndefined();
    expect(raced.folderError).toContain('deleted');
  });

  it('serializes concurrent same-name folder.create calls so only one reports created', async () => {
    const { service, projectRoot } = await createHarness();
    const [first, second] = await Promise.all([
      service.execute('folder.create', { name: 'Parallel' }, projectRoot),
      service.execute('folder.create', { name: 'parallel' }, projectRoot),
    ]);
    expect(first.folder.id).toBe(second.folder.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });
});
