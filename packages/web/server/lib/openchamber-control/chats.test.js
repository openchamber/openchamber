import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createOpenChamberControlService } from './service.js';
import { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import { createChatsScope, CHATS_SCOPE_PUBLIC_ID } from '../scheduled-tasks/chats-scope.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const setup = async ({ withProject = true, chatsInProject = false, chatsAvailable = true, symlinkRoot = false } = {}) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-chat-create-')));
  roots.push(root);
  const projectPath = path.join(root, 'project');
  await fs.mkdir(projectPath);
  if (chatsInProject) execFileSync('git', ['init', '--quiet', projectPath], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-git-config') },
  });
  let chatsParent = chatsInProject ? projectPath : root;
  if (symlinkRoot) {
    const alias = path.join(root, 'project-alias');
    await fs.symlink(chatsParent, alias, 'dir');
    chatsParent = alias;
  }
  const chatsScope = createChatsScope(path.join(chatsParent, 'custom-chats'));
  const sessions = [];
  const prompts = [];
  const events = [];
  const settings = { projects: withProject ? [{ id: 'project', path: projectPath }] : [] };
  const client = {
    session: {
      create: vi.fn(async (input) => {
        const session = { id: `ses_${sessions.length + 1}`, ...input };
        sessions.push(session);
        return session;
      }),
      get: async ({ sessionID }) => sessions.find((session) => session.id === sessionID),
      fork: async ({ sessionID }) => {
        const source = sessions.find((session) => session.id === sessionID);
        const session = { ...source, id: `ses_${sessions.length + 1}` };
        sessions.push(session);
        return session;
      },
      prompt: vi.fn(async (input) => { prompts.push(input); return { id: 'msg_1' }; }),
      switchModel: async () => {},
      switchAgent: async () => {},
      list: async ({ directory } = {}) => ({ data: sessions.filter((session) => !directory || session.location.directory === directory) }),
      active: async () => ({}),
    },
    message: { list: async ({ sessionID }) => ({ data: prompts
      .filter((prompt) => prompt.sessionID === sessionID)
      .map((prompt, index) => ({ id: `msg_${index}`, type: 'user', text: prompt.text, time: { created: index + 1 } })) }) },
    command: { list: async () => ({ data: [] }) },
    config: { get: async () => [] },
    model: { list: async () => ({ data: [{ providerID: 'test', id: 'model', variants: [] }] }) },
    agent: { list: async () => ({ data: [{ id: 'build', mode: 'primary' }, { id: 'plan', mode: 'primary' }] }) },
  };
  const dependencies = {
    chatsScope: chatsAvailable ? chatsScope : null,
    readSettingsFromDiskMigrated: async () => settings,
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => {
      try {
        const stat = await fs.stat(directory);
        return { ok: stat.isDirectory(), directory: await fs.realpath(directory) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
  };
  const sessionService = createOpenChamberSessionService({
    ...dependencies,
    dataDir: path.join(root, 'data'),
    createOpenCodeClient: () => client,
    emitSessionCreatedEvent: (event) => events.push(event),
  });
  const service = createOpenChamberControlService({ ...dependencies, sessionService, createClient: () => client });
  return { service, sessionService, chatsScope, projectPath, sessions, prompts, client, events, settings };
};

describe('agent session destinations', () => {
  it.each([false, true])('preserves user-authored titles when creating with Chats scope %s', async (inChats) => {
    const { sessionService, projectPath, client } = await setup();
    await sessionService.create({
      ...(inChats ? { projectId: CHATS_SCOPE_PUBLIC_ID } : { directory: projectPath }),
      title: 'My session',
    }, { titleByUser: true });
    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My session',
      metadata: { openchamber: { workTitle: { title: 'My session', by: 'user' } } },
    }));
  });

  it('creates a chat when there are no registered projects or caller directory', async () => {
    const { service, chatsScope } = await setup({ withProject: false });
    expect((await service.execute('projects.list')).projects).toEqual([
      { id: CHATS_SCOPE_PUBLIC_ID, path: chatsScope.root, label: 'Chats' },
    ]);
    const result = await service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID });
    expect(chatsScope.contains(result.directory)).toBe(true);
    expect((await fs.stat(result.directory)).isDirectory()).toBe(true);
  });

  it('keeps Chats projectless when the configured root is inside a registered checkout', async () => {
    const { service, projectPath, events, settings } = await setup({ chatsInProject: true });
    settings.defaultModel = 'test/model';
    settings.defaultAgent = 'build';
    settings.projects[0].defaultModel = 'test/project-model';
    settings.projects[0].defaultAgent = 'plan';
    const result = await service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID, prompt: 'Plan the week' }, projectPath);
    expect(result.projectId).toBeUndefined();
    expect(events[0].projectID).toBeUndefined();
    expect(result).toMatchObject({ model: { providerID: 'test', modelID: 'model' }, agent: 'build', promptDispatched: true });
    expect(events[0]).toMatchObject({ model: { providerID: 'test', modelID: 'model' }, agent: 'build' });
  });

  it('offers Chats and creates distinct chats from a project, with prompts and readable sessions', async () => {
    const { service, chatsScope, projectPath, sessions, prompts } = await setup();
    const { projects } = await service.execute('projects.list');
    expect(projects).toEqual([
      { id: 'project', path: projectPath, label: 'project' },
      { id: CHATS_SCOPE_PUBLIC_ID, path: chatsScope.root, label: 'Chats' },
    ]);
    // Discovery does not create a directory or start an OpenCode location.
    await expect(fs.stat(chatsScope.root)).rejects.toMatchObject({ code: 'ENOENT' });
    const input = { projectId: projects[1].id, title: 'Planning', prompt: 'Plan the week', model: 'test/model', agent: 'build' };
    const first = await service.execute('session.create', input, projectPath);
    const second = await service.execute('session.create', input, first.directory);
    expect(first).toMatchObject({ sessionId: 'ses_1', promptDispatched: true });
    expect(second.directory).not.toBe(first.directory);
    for (const result of [first, second]) {
      expect(chatsScope.contains(result.directory)).toBe(true);
      expect(path.relative(chatsScope.root, result.directory)).toMatch(/^\d{4}-\d{2}-\d{2}[/\\]session-/);
      expect((await fs.stat(result.directory)).isDirectory()).toBe(true);
      expect(result.projectId).toBeUndefined();
    }
    expect(sessions.map((session) => session.location.directory)).toEqual([first.directory, second.directory]);
    expect(prompts).toEqual([{ sessionID: 'ses_1', text: 'Plan the week' }, { sessionID: 'ses_2', text: 'Plan the week' }]);
    const target = { directory: first.directory, sessionId: first.sessionId };
    expect((await service.execute('session.list', { directory: first.directory }, projectPath)).sessions.map((session) => session.id)).toEqual(['ses_1']);
    const sent = await service.execute('session.send', { ...target, prompt: 'Continue', model: 'test/model', agent: 'build' }, projectPath);
    expect(sent).toMatchObject({ sessionId: first.sessionId, directory: first.directory, promptDispatched: true });
    const read = await service.execute('session.messages', target, projectPath);
    expect(read.messages.map((message) => message.text)).toEqual(['Plan the week', 'Continue']);
  });

  it.each([
    ['send', false], ['fork', false], ['send', true], ['fork', true],
  ])('uses global defaults on the first %s to an empty Chat inside a registered checkout with symlink root %s', async (action, symlinkRoot) => {
    const { service, projectPath, settings, chatsScope } = await setup({ chatsInProject: true, symlinkRoot });
    settings.defaultModel = 'test/model';
    settings.defaultAgent = 'build';
    settings.projects[0].defaultModel = 'test/project-model';
    settings.projects[0].defaultAgent = 'plan';
    const created = await service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID }, projectPath);
    if (symlinkRoot) {
      expect(await fs.realpath(chatsScope.root)).not.toBe(chatsScope.root);
      expect(created.directory).toBe(await fs.realpath(created.directory));
    }
    const result = await service.execute(`session.${action}`, {
      sessionId: created.sessionId,
      directory: created.directory,
      prompt: 'Plan the week',
    }, projectPath);
    expect(result).toMatchObject({
      directory: created.directory,
      model: { providerID: 'test', modelID: 'model' },
      agent: 'build',
      promptDispatched: true,
    });
  });

  it('preserves explicit project, directory and omitted-scope creation', async () => {
    const { service, projectPath, chatsScope } = await setup();
    for (const input of [{ projectId: 'project' }, { directory: projectPath }, {}]) {
      expect(await service.execute('session.create', input, projectPath)).toMatchObject({ directory: projectPath, projectId: 'project' });
    }
    await expect(service.execute('session.create', { projectId: 'missing' }, projectPath)).rejects.toMatchObject({ statusCode: 404 });
    await expect(fs.stat(chatsScope.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects conflicting scopes and worktrees before creating a chat directory', async () => {
    const { service, sessionService, projectPath, chatsScope } = await setup();
    for (const input of [{ directory: projectPath }, { worktree: 'branch' }, { pullRequest: 123 }]) {
      await expect(service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID, ...input }, projectPath)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(sessionService.create({ projectId: CHATS_SCOPE_PUBLIC_ID, directory: projectPath })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fs.stat(chatsScope.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Chats creation when the runtime has no Chats scope', async () => {
    const { service, chatsScope } = await setup({ chatsAvailable: false });
    expect((await service.execute('projects.list')).projects).toHaveLength(1);
    await expect(service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID })).rejects.toMatchObject({ statusCode: 503 });
    await expect(fs.stat(chatsScope.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans an empty directory when session creation fails and keeps one after a prompt failure', async () => {
    const { service, chatsScope, client, sessions } = await setup();
    client.session.create.mockRejectedValueOnce(new Error('creation failed'));
    await expect(service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID })).rejects.toThrow('creation failed');
    const dates = await fs.readdir(chatsScope.root);
    expect(await fs.readdir(path.join(chatsScope.root, dates[0]))).toEqual([]);

    client.session.prompt.mockRejectedValueOnce(new Error('prompt failed'));
    await expect(service.execute('session.create', {
      projectId: CHATS_SCOPE_PUBLIC_ID, prompt: 'Hello', model: 'test/model', agent: 'build',
    })).rejects.toThrow('prompt failed');
    expect((await fs.stat(sessions[0].location.directory)).isDirectory()).toBe(true);
  });

  it('removes an empty allocation after selection validation fails', async () => {
    const { service, chatsScope, client } = await setup();
    await expect(service.execute('session.create', {
      projectId: CHATS_SCOPE_PUBLIC_ID, prompt: 'Hello', model: 'test/missing',
    })).rejects.toThrow('Unknown model');
    expect(client.session.create).not.toHaveBeenCalled();
    const [date] = await fs.readdir(chatsScope.root);
    expect(await fs.readdir(path.join(chatsScope.root, date))).toEqual([]);
  });

  it('preserves files left in the allocation when creation fails', async () => {
    const { service, client } = await setup();
    let savedFile;
    client.session.create.mockImplementationOnce(async ({ location }) => {
      savedFile = path.join(location.directory, 'keep.txt');
      await fs.writeFile(savedFile, 'Keep this content');
      throw new Error('creation failed');
    });
    await expect(service.execute('session.create', { projectId: CHATS_SCOPE_PUBLIC_ID })).rejects.toThrow('creation failed');
    expect(await fs.readFile(savedFile, 'utf8')).toBe('Keep this content');
  });
});
