import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { resolveProjectForSessionDirectory } from '../../../../ui/src/lib/projectResolution';
import { partitionWorktreesByRegisteredProject } from '../../../../ui/src/lib/worktrees/worktreeManager';
import { getWorktrees, isGitRepository, resolvePrimaryWorktreeRoot } from '../git/service.js';
import { createMemoryProjectResolver } from '../agent-memory/project-resolution.js';
import { createAgentToolRuntime } from '../agent-tool/runtime.js';
import { createProjectContextRuntime } from '../project-context/runtime.js';
import { registerProjectContextRoutes } from '../project-context/routes.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createKnowledgeOwnerResolver } from './knowledge-owner.js';
import { createOpenChamberControlService } from './service.js';
import { OpenChamberControlError } from './error.js';

const run = promisify(execFile);
const git = (directory, args) => run('git', ['-C', directory, ...args]);

describe('knowledge owner authenticated callback integration', () => {
  it('stores generated notes under the panel owner for HOME, nested projects, worktrees and Chats', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-owner-'));
    const home = path.join(root, 'home');
    const nested = path.join(home, 'workspaces', 'independent');
    const primary = path.join(home, 'primary');
    const worktree = path.join(home, 'trees', 'task');
    const foreign = path.join(root, 'foreign');
    const chats = path.join(root, 'chats');
    const legacyChats = path.join(home, '.config', 'openchamber', 'chats');
    const chatsAlias = path.join(root, 'chats-alias');
    const projects = [{ id: 'home', path: home }, { id: 'primary', path: primary }, { id: 'foreign', path: foreign }];
    const sessions = new Map([
      ['ses_home', nested], ['ses_tree', path.join(worktree, 'src')], ['ses_foreign', foreign],
      ['ses_chats', path.join(chatsAlias, 'day', 'session')], ['ses_legacy', path.join(legacyChats, 'day', 'session')],
    ]);
    const changes = [];
    const previousEnv = { url: process.env.OPENCHAMBER_AGENT_TOOL_URL, token: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN };
    let server;
    try {
      await Promise.all([nested, primary, foreign, chats, legacyChats].map((directory) => fs.mkdir(directory, { recursive: true })));
      await fs.symlink(chats, chatsAlias);
      await git(nested, ['init', '--quiet']);
      await git(primary, ['init', '--quiet']);
      await git(primary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
      await git(primary, ['worktree', 'add', '--quiet', '--detach', worktree]);
      await fs.mkdir(path.join(worktree, 'src'));

      const listProjectPaths = async () => projects.map((project) => project.path);
      let discoveryFails = false;
      const resolveProjectContextId = createKnowledgeOwnerResolver({
        listProjectPaths,
        getWorktrees: async (directory) => {
          if (discoveryFails && directory === primary) throw new Error('Worktree discovery failed');
          return getWorktrees(directory);
        },
        resolvePrimaryWorktreeRoot, isGitRepository, managedProjectRoots: [chatsAlias, legacyChats],
      });
      const memoryResolver = createMemoryProjectResolver({ listProjectPaths, resolvePrimaryWorktreeRoot });
      // Existing memory semantics continue to choose the independent repository.
      expect(await memoryResolver(nested)).toBe(createProjectIdFromPath(nested));
      const storage = createProjectContextRuntime({
        fsPromises: fs, path, projectsDirPath: path.join(root, 'data', 'projects'),
        createId: () => crypto.randomUUID(), onChanged: (owner) => changes.push(owner),
      });
      const oldNestedOwner = createProjectIdFromPath(nested);
      await storage.createNote(oldNestedOwner, { body: 'Existing misplaced data', source: 'manual' });
      const oldNestedBytes = await fs.readFile(storage.contextPathFor(oldNestedOwner), 'utf8');

      const service = createOpenChamberControlService({
        projectContextRuntime: storage, resolveProjectContextId,
        sessionService: { resolveDirectory: async ({ projectId }) => {
          if (projectId === 'missing-folder') throw new OpenChamberControlError('Project folder missing', 400);
          const project = projects.find((entry) => entry.id === projectId);
          if (!project) throw new OpenChamberControlError('Project not found', 404);
          return project.path;
        } },
      });
      const runtime = createAgentToolRuntime({
        crypto, fsPromises: fs, path, dataDir: path.join(root, 'data'), getActivePort: () => 1,
        resolveSessionDirectory: async (id) => sessions.get(id) || null,
        executeAction: (...args) => service.execute(...args),
      });
      const pluginDirectory = await runtime.materializePlugin({ includeWeb: false, includeMemory: false });
      const env = runtime.createChildEnv();
      const plugin = await import(pathToFileURL(path.join(pluginDirectory, 'index.js')).href);
      const tools = {};
      await plugin.default.setup({ tool: { transform: (edit) => edit({ add: (tool) => { tools[tool.name] = tool; } }) } });
      const app = express();
      runtime.registerRoutes(app, express);
      registerProjectContextRoutes(app, { projectContextRuntime: storage });
      server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      process.env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${server.address().port}/api/openchamber/agent-tool`;
      process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      const call = async (sessionID, action, parameters = {}) => JSON.parse((await tools.openchamber.execute(
        { action, parameters }, { sessionID, progress: async () => {} },
      )).content);
      const panelOwner = async (directory) => {
        const topology = new Map();
        for (const project of projects) {
          const { root: projectDirectory } = await resolvePrimaryWorktreeRoot(project.path);
          topology.set(project.path, (await getWorktrees(project.path))
            .filter((entry) => entry.path !== project.path).map((entry) => ({ ...entry, projectDirectory })));
        }
        const project = resolveProjectForSessionDirectory(projects, partitionWorktreesByRegisteredProject(projects, topology), directory);
        return project ? createProjectIdFromPath(project.path) : '';
      };
      const createAndReadPanel = async (sessionID, expectedPath, body) => {
        const owner = createProjectIdFromPath(expectedPath);
        const created = await call(sessionID, 'notes.create', { body });
        expect(created).toMatchObject({ ok: true, data: { projectId: owner, note: { body, source: 'agent', origin: { sessionId: sessionID } } } });
        const panel = await request(app).get(`/api/project-context/${owner}`).expect(200);
        expect(panel.body.notes).toContainEqual(expect.objectContaining({ id: created.data.note.id, body }));
        expect(changes.at(-1)).toBe(owner);
        return created;
      };

      expect(await panelOwner(nested)).toBe(createProjectIdFromPath(home));
      await createAndReadPanel('ses_home', home, 'HOME panel note');
      expect(await fs.readFile(storage.contextPathFor(oldNestedOwner), 'utf8')).toBe(oldNestedBytes);
      expect(await panelOwner(path.join(worktree, 'src'))).toBe(createProjectIdFromPath(primary));
      await createAndReadPanel('ses_tree', primary, 'Worktree panel note');
      const homeBeforeFailure = await fs.readFile(storage.contextPathFor(createProjectIdFromPath(home)), 'utf8');
      const primaryBeforeFailure = await fs.readFile(storage.contextPathFor(createProjectIdFromPath(primary)), 'utf8');
      const changesBeforeFailure = changes.length;
      discoveryFails = true;
      expect(await call('ses_tree', 'notes.create', { body: 'Must not fall back to HOME' }))
        .toMatchObject({ ok: false, error: { message: 'Worktree discovery failed' } });
      expect(changes).toHaveLength(changesBeforeFailure);
      expect(await fs.readFile(storage.contextPathFor(createProjectIdFromPath(home)), 'utf8')).toBe(homeBeforeFailure);
      expect(await fs.readFile(storage.contextPathFor(createProjectIdFromPath(primary)), 'utf8')).toBe(primaryBeforeFailure);
      discoveryFails = false;
      await createAndReadPanel('ses_chats', chatsAlias, 'Canonical Chats note');
      await createAndReadPanel('ses_legacy', legacyChats, 'Legacy Chats note');
      await createAndReadPanel('ses_foreign', foreign, 'Foreign session note');
      expect((await call('ses_home', 'notes.list')).data.notes.map((note) => note.body)).toEqual(['HOME panel note']);

      projects.push({ id: 'nested', path: nested });
      expect(await panelOwner(nested)).toBe(oldNestedOwner);
      await createAndReadPanel('ses_home', nested, 'Registered nested panel note');
      expect(await memoryResolver(nested)).toBe(oldNestedOwner);
      projects.push({ id: 'tree', path: worktree });
      expect(await panelOwner(path.join(worktree, 'src'))).toBe(createProjectIdFromPath(worktree));
      await createAndReadPanel('ses_tree', worktree, 'Registered worktree panel note');

      expect(await call('ses_home', 'notes.list', { projectId: 'home' })).toMatchObject({ ok: true, data: { projectId: createProjectIdFromPath(home) } });
      expect(await call('ses_foreign', 'notes.list', { directory: nested })).toMatchObject({ ok: true, data: { projectId: oldNestedOwner } });
      const beforeErrors = changes.length;
      for (const parameters of [
        { projectId: 'missing' }, { projectId: 'missing-folder' }, { projectId: 'home', directory: nested },
        { directory: 'relative' }, { directory: `${home}-other` }, { directory: `${chatsAlias}-other` },
      ]) expect((await call('ses_home', 'notes.create', { ...parameters, body: 'Must not write' })).ok).toBe(false);
      expect((await call('ses_unknown', 'notes.create', { body: 'Must not write' })).ok).toBe(false);
      expect(changes).toHaveLength(beforeErrors);
      const spoof = await request(app).post('/api/openchamber/agent-tool')
        .set('Authorization', `Bearer ${env.OPENCHAMBER_AGENT_TOOL_TOKEN}`)
        .send({ tool: 'openchamber', sessionID: 'ses_foreign', contextDirectory: nested, contextSessionId: 'ses_home', input: { action: 'notes.create', body: 'Trusted session' } }).expect(200);
      expect(spoof.body).toMatchObject({ ok: true, data: { projectId: createProjectIdFromPath(foreign), note: { origin: { sessionId: 'ses_foreign' } } } });
      const beforeAuth = changes.length;
      await request(app).post('/api/openchamber/agent-tool')
        .set('Authorization', 'Bearer wrong-token')
        .send({ tool: 'openchamber', sessionID: 'ses_home', input: { action: 'notes.create', body: 'Must not write' } }).expect(401);
      expect(changes).toHaveLength(beforeAuth);
    } finally {
      if (previousEnv.url === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_URL;
      else process.env.OPENCHAMBER_AGENT_TOOL_URL = previousEnv.url;
      if (previousEnv.token === undefined) delete process.env.OPENCHAMBER_AGENT_TOOL_TOKEN;
      else process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = previousEnv.token;
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
