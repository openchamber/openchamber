import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerSkillRoutes } from './skill-routes.js';
import {
  createSkill,
  deleteSkill,
  discoverSkills,
  getSkillSources,
  isManagedSkillPath,
  mergeDiscoveredSkills,
  renameSkill,
  updateSkill,
} from './skills.js';
import {
  SKILL_DIR,
  SKILL_SCOPE,
  deleteSkillSupportingFile,
  readSkillSupportingFile,
  writeSkillSupportingFile,
} from './shared.js';
import { clearCache, scanWithCache } from '../skills-catalog/cache.js';

const createTempProject = () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-routes-'));
  fs.mkdirSync(path.join(projectRoot, '.git'));
  return projectRoot;
};

const startSkillsApp = ({
  projectRoot,
  scanSkillsRepository = async () => ({ ok: false }),
  installSkillsFromRepository = async () => ({ ok: false }),
  overrides = {},
  scanWithCache: scanWithCacheImpl = async (_key, loader, options) => loader({ signal: options?.signal }),
  getCuratedSkillsSources = () => [],
  parseSkillRepoSource = () => ({ ok: false }),
} = {}) => {
  const app = express();
  app.use(express.json());

  registerSkillRoutes(app, {
    fs,
    path,
    os,
    resolveProjectDirectory: async () => ({ directory: projectRoot, error: null }),
    resolveOptionalProjectDirectory: async (req) => {
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      if (!queryDirectory) {
        return { directory: null, error: null };
      }
      return { directory: String(queryDirectory), error: null };
    },
    readSettingsFromDisk: async () => ({}),
    sanitizeSkillCatalogs: (value) => value,
    isUnsafeSkillRelativePath: () => false,
    refreshOpenCodeAfterConfigChange: async () => {},
    clientReloadDelayMs: 0,
    buildOpenCodeUrl: () => 'http://127.0.0.1:9/',
    getOpenCodeAuthHeaders: () => ({}),
    getOpenCodePort: () => 0,
    getSkillSources,
    discoverSkills,
    mergeDiscoveredSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    renameSkill,
    isManagedSkillPath,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources,
    getCacheKey: () => 'k',
    scanWithCache: scanWithCacheImpl,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    fetchGitHubRepoMetas: async () => ({}),
    getProfiles: () => [],
    getProfile: () => null,
    ...overrides,
  });

  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
};

describe('skill-routes directory soft fallback', () => {
  /** @type {string | null} */
  let projectRoot = null;
  /** @type {{ close: () => Promise<void> } | null} */
  let appHandle = null;

  afterEach(async () => {
    clearCache();
    if (appHandle) {
      await appHandle.close();
      appHandle = null;
    }
    if (projectRoot) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = null;
    }
  });

  it('lists repository-local .agents skills after create even when list omits directory', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    const createResponse = await fetch(`${appHandle.baseUrl}/api/config/skills/repo-local-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Created without list directory',
        instructions: 'Do the thing.',
        scope: 'project',
        source: 'agents',
      }),
    });
    expect(createResponse.status).toBe(200);
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'skills', 'repo-local-skill', 'SKILL.md'))).toBe(true);

    const listResponse = await fetch(`${appHandle.baseUrl}/api/config/skills`);
    expect(listResponse.status).toBe(200);
    const payload = await listResponse.json();
    expect(payload.skills.map((skill) => skill.name)).toContain('repo-local-skill');
    const skill = payload.skills.find((entry) => entry.name === 'repo-local-skill');
    expect(skill.scope).toBe('project');
    expect(skill.source).toBe('agents');
  });

  it('lists manually created repository-local .agents skills via active-project fallback', async () => {
    projectRoot = createTempProject();
    const skillDir = path.join(projectRoot, '.agents', 'skills', 'manual-repo-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manual-repo-skill',
        'description: Manual repository skill',
        '---',
        '',
        'Instructions',
        '',
      ].join('\n'),
      'utf8',
    );

    appHandle = startSkillsApp({ projectRoot });
    const listResponse = await fetch(`${appHandle.baseUrl}/api/config/skills`);
    expect(listResponse.status).toBe(200);
    const payload = await listResponse.json();
    expect(payload.skills.map((skill) => skill.name)).toContain('manual-repo-skill');
  });

  it('marks managed-root skills renamable and cache skills not renamable', async () => {
    projectRoot = createTempProject();
    const managedDir = path.join(projectRoot, '.opencode', 'skills', 'managed-list-skill');
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      path.join(managedDir, 'SKILL.md'),
      [
        '---',
        'name: managed-list-skill',
        'description: Managed list skill',
        '---',
        '',
        'Managed body',
        '',
      ].join('\n'),
      'utf8',
    );

    const cacheStamp = `oc-skill-routes-${Date.now()}`;
    const cacheDir = path.join(os.homedir(), '.cache', 'opencode', 'skills', cacheStamp, 'cache-list-skill');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'SKILL.md'),
      [
        '---',
        'name: cache-list-skill',
        'description: Cache list skill',
        '---',
        '',
        'Cache body',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      appHandle = startSkillsApp({ projectRoot });
      const listResponse = await fetch(
        `${appHandle.baseUrl}/api/config/skills?directory=${encodeURIComponent(projectRoot)}`,
      );
      expect(listResponse.status).toBe(200);
      const payload = await listResponse.json();

      const managed = payload.skills.find((entry) => entry.name === 'managed-list-skill');
      const cached = payload.skills.find((entry) => entry.name === 'cache-list-skill');

      expect(managed).toBeTruthy();
      expect(managed.renamable).toBe(true);
      expect(cached).toBeTruthy();
      expect(cached.renamable).toBe(false);
    } finally {
      fs.rmSync(path.join(os.homedir(), '.cache', 'opencode', 'skills', cacheStamp), {
        recursive: true,
        force: true,
      });
    }
  });

  it('lists OpenCode skills reported with the v2 `path` field and keeps the v1 `location` fallback', async () => {
    projectRoot = createTempProject();

    // OpenCode v2's skill payload renamed `location` to `path`. The route maps
    // the fetch result to { name, path, ... }; with the old field only, the
    // whole authoritative list was dropped and the panel fell back to the
    // smaller local disk scan. Serve a v2-style payload from a stub.
    const stub = express();
    stub.get('/api/skill', (_req, res) => {
      res.json({
        location: { directory: projectRoot },
        data: [
          {
            id: 'v2-path-skill',
            name: 'v2-path-skill',
            path: path.join(projectRoot, '.agents', 'skills', 'v2-path-skill'),
            description: 'Delivered with the v2 path field',
          },
          {
            id: 'v1-location-skill',
            name: 'v1-location-skill',
            location: path.join(projectRoot, '.agents', 'skills', 'v1-location-skill'),
            description: 'Delivered with the legacy location field',
          },
          {
            id: 'opencode',
            name: 'OpenCode',
            path: '/builtin/opencode.md',
            description: 'v2 built-in skill with a synthetic path',
          },
          {
            id: 'unlocated-skill',
            name: 'unlocated-skill',
            description: 'Has neither field; must be dropped',
          },
        ],
      });
    });
    const stubServer = await new Promise((resolve) => {
      const server = stub.listen(0, () => resolve(server));
    });
    const stubPort = stubServer.address().port;

    try {
      appHandle = startSkillsApp({
        projectRoot,
        overrides: {
          buildOpenCodeUrl: () => `http://127.0.0.1:${stubPort}/`,
          getOpenCodePort: () => stubPort,
          getOpenCodeAuthHeaders: () => ({}),
        },
      });

      const listResponse = await fetch(
        `${appHandle.baseUrl}/api/config/skills?directory=${encodeURIComponent(projectRoot)}`,
      );
      expect(listResponse.status).toBe(200);
      const payload = await listResponse.json();
      const byName = new Map(payload.skills.map((skill) => [skill.name, skill]));

      expect(byName.has('v2-path-skill')).toBe(true);
      expect(byName.get('v2-path-skill').path).toContain('v2-path-skill');

      expect(byName.has('v1-location-skill')).toBe(true);
      expect(byName.get('v1-location-skill').path).toContain('v1-location-skill');

      expect(byName.get('OpenCode')?.path).toBe('<built-in>');
      expect(byName.get('OpenCode')?.renamable).toBe(false);

      expect(byName.has('unlocated-skill')).toBe(false);
    } finally {
      stubServer.close();
    }
  });
  it('flags the list as partial when OpenCode skill list fails, and not when it succeeds', async () => {
    projectRoot = createTempProject();
    fs.mkdirSync(path.join(projectRoot, '.agents', 'skills', 'disk-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.agents', 'skills', 'disk-skill', 'SKILL.md'),
      '---\nname: disk-skill\ndescription: On disk\n---\nBody\n',
    );

    let failing = true;
    const stub = express();
    stub.get('/api/skill', (_req, res) => {
      if (failing) {
        res.status(500).json({ error: 'boom' });
        return;
      }
      res.json({ data: [] });
    });
    const stubServer = await new Promise((resolve) => {
      const server = stub.listen(0, () => resolve(server));
    });
    const stubPort = stubServer.address().port;

    try {
      appHandle = startSkillsApp({
        projectRoot,
        overrides: {
          buildOpenCodeUrl: () => `http://127.0.0.1:${stubPort}/`,
          getOpenCodePort: () => stubPort,
        },
      });
      const url = `${appHandle.baseUrl}/api/config/skills?directory=${encodeURIComponent(projectRoot)}`;

      const failed = await (await fetch(url)).json();
      expect(failed.openCodeSkillsUnavailable).toBe(true);
      expect(failed.skills.map((skill) => skill.name)).toContain('disk-skill');

      failing = false;
      const complete = await (await fetch(url)).json();
      expect(complete.openCodeSkillsUnavailable).toBeUndefined();
      expect(complete.skills.map((skill) => skill.name)).toContain('disk-skill');
    } finally {
      stubServer.close();
    }
  });

  it('cancels a direct repository scan when the HTTP request disconnects', async () => {
    projectRoot = createTempProject();
    let receivedSignal;
    let resolveStarted;
    let resolveStopped;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });

    appHandle = startSkillsApp({
      projectRoot,
      scanSkillsRepository: async ({ signal }) => {
        receivedSignal = signal;
        resolveStarted();
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolveStopped();
            resolve();
          }, { once: true });
        });
        return { ok: false, error: { kind: 'networkError', message: 'request cancelled' } };
      },
    });

    const controller = new AbortController();
    const request = fetch(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repository' }),
      signal: controller.signal,
    });
    const requestOutcome = request.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );

    await started;
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await stopped;
    await expect(requestOutcome).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(receivedSignal.aborted).toBe(true);
  });

  it('cancels a direct repository install when the HTTP request disconnects', async () => {
    projectRoot = createTempProject();
    let receivedSignal;
    let resolveStarted;
    let resolveStopped;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });

    appHandle = startSkillsApp({
      projectRoot,
      installSkillsFromRepository: async ({ signal }) => {
        receivedSignal = signal;
        resolveStarted();
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolveStopped();
            resolve();
          }, { once: true });
        });
        return { ok: false, error: { kind: 'networkError', message: 'request cancelled' } };
      },
    });

    const controller = new AbortController();
    const request = fetch(`${appHandle.baseUrl}/api/config/skills/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'owner/repository',
        scope: 'project',
        selections: [{ skillDir: 'skills/example' }],
      }),
      signal: controller.signal,
    });
    const requestOutcome = request.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );

    await started;
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await stopped;
    await expect(requestOutcome).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(receivedSignal.aborted).toBe(true);
  });

  it('cancels one catalog source waiter without aborting the shared scan for another request', async () => {
    projectRoot = createTempProject();
    let receivedSignal;
    let resolveStarted;
    let resolveScan;
    let cacheCalls = 0;
    let resolveSecondCacheCall;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const scanFinished = new Promise((resolve) => { resolveScan = resolve; });
    const secondCacheCall = new Promise((resolve) => { resolveSecondCacheCall = resolve; });

    appHandle = startSkillsApp({
      projectRoot,
      scanWithCache: (...args) => {
        cacheCalls += 1;
        if (cacheCalls === 2) resolveSecondCacheCall();
        return scanWithCache(...args);
      },
      getCuratedSkillsSources: () => ([
        { id: 'source', label: 'Source', source: 'owner/repository' },
      ]),
      parseSkillRepoSource: () => ({
        ok: true,
        host: 'github.com',
        normalizedRepo: 'owner/repository',
        effectiveSubpath: null,
      }),
      scanSkillsRepository: async ({ signal }) => {
        receivedSignal = signal;
        resolveStarted();
        await scanFinished;
        return {
          ok: true,
          items: [{ skillName: 'example', description: 'Example' }],
        };
      },
    });

    const firstController = new AbortController();
    const first = fetch(`${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=source`, {
      signal: firstController.signal,
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await started;

    const second = fetch(`${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=source`);
    await secondCacheCall;
    firstController.abort();
    await expect(first).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal.aborted).toBe(false);

    resolveScan();
    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      ok: true,
      items: [{ skillName: 'example' }],
    });
    expect(receivedSignal.aborted).toBe(false);
  });

  it('aborts the catalog scan source after the last disconnected waiter and lets its cleanup finish', async () => {
    projectRoot = createTempProject();
    let receivedSignal;
    let resolveStarted;
    let resolveCleanup;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const cleanup = new Promise((resolve) => { resolveCleanup = resolve; });

    appHandle = startSkillsApp({
      projectRoot,
      scanWithCache,
      getCuratedSkillsSources: () => ([
        { id: 'source', label: 'Source', source: 'owner/repository' },
      ]),
      parseSkillRepoSource: () => ({
        ok: true,
        host: 'github.com',
        normalizedRepo: 'owner/repository',
        effectiveSubpath: null,
      }),
      scanSkillsRepository: async ({ signal }) => {
        receivedSignal = signal;
        resolveStarted();
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        await cleanup;
        return { ok: false, error: { kind: 'networkError', message: 'cancelled' } };
      },
    });

    const controller = new AbortController();
    const request = fetch(`${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=source`, {
      signal: controller.signal,
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await started;
    const sourceAbort = new Promise((resolve) => {
      receivedSignal.addEventListener('abort', resolve, { once: true });
    });
    controller.abort();
    await expect(request).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } });
    await sourceAbort;
    expect(receivedSignal.aborted).toBe(true);

    resolveCleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearCache();
  });
});
