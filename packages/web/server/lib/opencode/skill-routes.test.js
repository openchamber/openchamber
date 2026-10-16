import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerSkillRoutes } from './skill-routes.js';
import {
  createSkill,
  deleteSkill,
  deleteSkillAt,
  discoverSkills,
  getSkillSources,
  isDeletableSkillPath,
  isManagedSkillPath,
  mergeDiscoveredSkills,
  renameSkill,
  updateSkill,
} from './skills.js';
import {
  SKILL_DIR,
  SKILL_SCOPE,
  deleteSkillSupportingFile,
  readConfigFile,
  readSkillSupportingFile,
  writeConfig,
  writeSkillSupportingFile,
} from './shared.js';
import { createSkillPolicyService } from './skill-policy.js';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';

// A `skillPolicy` answer's entries by id.
const byId = (skillPolicy) => new Map(skillPolicy.skills.map(({ id, ...entry }) => [id, entry]));

const createTempProject = () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-routes-'));
  fs.mkdirSync(path.join(projectRoot, '.git'));
  return projectRoot;
};

const startSkillsApp = ({ projectRoot, overrides = {} }) => {
  const app = express();
  app.use(express.json());

  const skillRoutes = registerSkillRoutes(app, {
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
    deleteSkillAt,
    isDeletableSkillPath,
    renameSkill,
    isManagedSkillPath,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources: () => [],
    getCacheKey: () => 'k',
    scanWithCache: async (_key, loader) => loader(),
    parseSkillRepoSource: () => ({ ok: false }),
    scanSkillsRepository: async () => ({ ok: false }),
    installSkillsFromRepository: async () => ({ ok: false }),
    fetchGitHubRepoMetas: async () => ({}),
    getProfiles: () => [],
    getProfile: () => null,
    ...overrides,
  });

  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    skillRoutes,
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
  it('hides a curated source\'s excluded skills from its catalog listing', async () => {
    projectRoot = createTempProject();
    const scanItem = (skillName) => ({ repoSource: 'acme/skills', skillDir: `skills/${skillName}`, skillName, installable: true });
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        getCuratedSkillsSources: () => [
          { id: 'acme', label: 'Acme', source: 'acme/skills', defaultSubpath: 'skills', excludedSkills: ['docx'] },
        ],
        parseSkillRepoSource: () => ({ ok: true, host: 'github.com', normalizedRepo: 'acme/skills' }),
        scanSkillsRepository: async () => ({ ok: true, items: [scanItem('docx'), scanItem('frontend-design')] }),
      },
    });

    const sourceResponse = await fetch(
      `${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=acme&directory=${encodeURIComponent(projectRoot)}`,
    );
    expect(sourceResponse.status).toBe(200);
    const sourcePayload = await sourceResponse.json();
    expect(sourcePayload.items.map((item) => item.skillName)).toEqual(['frontend-design']);

    const catalogResponse = await fetch(`${appHandle.baseUrl}/api/config/skills/catalog`);
    const catalogPayload = await catalogResponse.json();
    expect(catalogPayload.sources[0]).not.toHaveProperty('excludedSkills');
  });

  it('marks installed only for the source the skill was installed from', async () => {
    projectRoot = createTempProject();
    const skillDir = path.join(projectRoot, '.agents', 'skills', 'skill-creator');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: skill-creator\ndescription: Creates skills\n---\nBody\n');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skills-data-'));
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'skills-installed-sources.json'), JSON.stringify({
        version: 1,
        entries: [{ skillName: 'skill-creator', skillDir: 'skills/skill-creator', scope: 'user', source: 'opencode', sourceId: 'acme', sourceRef: 'acme/skills' }],
      }));

      const scanItem = (repoSource) => ({ repoSource, skillDir: 'skills/skill-creator', skillName: 'skill-creator', installable: true });
      appHandle = startSkillsApp({
        projectRoot,
        overrides: {
          getCuratedSkillsSources: () => [
            { id: 'acme', label: 'Acme', source: 'acme/skills', defaultSubpath: 'skills' },
            { id: 'other', label: 'Other', source: 'other/skills', defaultSubpath: 'skills' },
          ],
          parseSkillRepoSource: () => ({ ok: true, host: 'github.com', normalizedRepo: 'owner/repo' }),
          scanSkillsRepository: async (input) => ({ ok: true, items: [scanItem(input?.source === 'other/skills' ? 'other/skills' : 'acme/skills')] }),
        },
      });

      const fromAcme = await (await fetch(
        `${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=acme&directory=${encodeURIComponent(projectRoot)}`,
      )).json();
      expect(fromAcme.items).toHaveLength(1);
      expect(fromAcme.items[0].installed).toMatchObject({ isInstalled: true });

      const fromOther = await (await fetch(
        `${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=other&directory=${encodeURIComponent(projectRoot)}`,
      )).json();
      expect(fromOther.items).toHaveLength(1);
      expect(fromOther.items[0].installed).toMatchObject({ isInstalled: false });

      // A name the registry has never heard of keeps the old name match.
      fs.rmSync(path.join(dataDir, 'skills-installed-sources.json'));
      const legacy = await (await fetch(
        `${appHandle.baseUrl}/api/config/skills/catalog/source?sourceId=other&directory=${encodeURIComponent(projectRoot)}`,
      )).json();
      expect(legacy.items[0].installed).toMatchObject({ isInstalled: true });
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records install provenance for what an install returned', async () => {
    projectRoot = createTempProject();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skills-data-'));
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    try {
      appHandle = startSkillsApp({
        projectRoot,
        overrides: {
          resolveCatalogGitIdentity: async () => ({ ok: true, identity: { transport: 'https', credentialId: 'ref', endpoint: 'https://github.com/owner/repo.git' } }),
          installSkillsFromRepository: async () => ({
            ok: true,
            installed: [{ skillName: 'skill-creator', skillDir: 'skills/skill-creator', scope: 'user', source: 'opencode' }],
            skipped: [],
          }),
        },
      });

      const install = await fetch(`${appHandle.baseUrl}/api/config/skills/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          source: 'owner/repo',
          sourceId: 'acme',
          scope: 'user',
          selections: [{ skillDir: 'skills/skill-creator' }],
        }),
      });
      expect(install.status).toBe(200);

      const payload = JSON.parse(fs.readFileSync(path.join(dataDir, 'skills-installed-sources.json'), 'utf8'));
      expect(payload.version).toBe(1);
      expect(payload.entries).toContainEqual(expect.objectContaining({
        skillName: 'skill-creator',
        skillDir: 'skills/skill-creator',
        sourceId: 'acme',
        sourceRef: 'owner/repo',
      }));
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('leaves supporting files out of the list and keeps them in the skill detail', async () => {
    projectRoot = createTempProject();
    const skillDir = path.join(projectRoot, '.agents', 'skills', 'files-skill');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: files-skill\ndescription: Has files\n---\nBody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'references', 'guide.md'), '# Guide\n');

    appHandle = startSkillsApp({ projectRoot });
    const query = `?directory=${encodeURIComponent(projectRoot)}`;

    const list = await (await fetch(`${appHandle.baseUrl}/api/config/skills${query}`)).json();
    const listed = list.skills.find((skill) => skill.name === 'files-skill');
    expect(listed.sources.md.description).toBe('Has files');
    expect(listed.sources.md).not.toHaveProperty('supportingFiles');

    const detail = await (await fetch(`${appHandle.baseUrl}/api/config/skills/files-skill${query}`)).json();
    expect(detail.sources.md.supportingFiles).toEqual([{
      name: 'guide.md',
      path: path.join('references', 'guide.md'),
      fullPath: path.join(skillDir, 'references', 'guide.md'),
    }]);
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

  it('resolves account-token identities for scan and install', async () => {
    projectRoot = createTempProject();
    const account = { provider: 'github', instance: 'github.com', accountId: 'account-one' };
    const profile = { id: 'work', transport: 'account', account };
    const credentialResolver = { resolve: async () => ({}) };
    const resolved = [];
    const scanResponse = { ok: true, items: [] };
    const installResponse = { ok: true, installed: [], skipped: [] };
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        getProfile: () => profile,
        resolveSourceControlAccount: async (input) => {
          expect(input).toEqual(account);
          return {
            credentialId: 'account-one',
            credentialRevision: 3,
            providerUserId: 'github.com#42',
            status: 'valid',
          };
        },
        createHttpsCredentialReference: (input) => {
          expect(input).toEqual({
            provider: 'github',
            instance: 'github.com',
            credentialId: 'account-one',
            credentialRevision: 3,
            providerUserId: 'github.com#42',
          });
          return 'managed-account-reference';
        },
        credentialResolver,
        parseSkillRepoSource: () => ({
          ok: true,
          host: 'github.com',
          cloneUrlSsh: 'git@github.com:owner/private.git',
          cloneUrlHttps: 'https://github.com/owner/private.git',
        }),
        scanSkillsRepository: async (input) => {
          resolved.push(input);
          return scanResponse;
        },
        installSkillsFromRepository: async (input) => {
          resolved.push(input);
          return installResponse;
        },
      },
    });

    const scan = await fetch(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/private', gitIdentityId: 'work' }),
    });
    expect(scan.status).toBe(200);

    const install = await fetch(`${appHandle.baseUrl}/api/config/skills/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'owner/private',
        gitIdentityId: 'work',
        scope: 'user',
        selections: [{ skillDir: 'skills/private-skill' }],
      }),
    });
    expect(install.status).toBe(200);
    expect(resolved).toHaveLength(2);
    for (const input of resolved) {
      expect(input.identity).toEqual({
        transport: 'https',
        credentialId: 'managed-account-reference',
        endpoint: 'https://github.com/owner/private.git',
      });
      expect(input.credentialResolver).toBe(credentialResolver);
    }
  });

  it('uses the managed SSH identity and endpoint for catalog scans', async () => {
    projectRoot = createTempProject();
    let scanInput;
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        getProfile: () => ({
          id: 'deploy',
          transport: 'ssh',
          sshCredentialId: 'ocgit:v1:ssh:key-one',
        }),
        parseSkillRepoSource: () => ({
          ok: true,
          host: 'git.example.com',
          cloneUrlSsh: 'git@git.example.com:owner/private.git',
          cloneUrlHttps: 'https://git.example.com/owner/private.git',
        }),
        scanSkillsRepository: async (input) => {
          scanInput = input;
          return { ok: true, items: [] };
        },
      },
    });

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'git@git.example.com:owner/private.git', gitIdentityId: 'deploy' }),
    });
    expect(response.status).toBe(200);
    expect(scanInput.identity).toEqual({
      transport: 'ssh',
      credentialId: 'ocgit:v1:ssh:key-one',
      endpoint: 'git@git.example.com:owner/private.git',
    });
  });

  it('keeps the System identity on the server Git configuration', async () => {
    projectRoot = createTempProject();
    let scanInput;
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        parseSkillRepoSource: () => ({
          ok: true,
          cloneUrlSsh: 'git@github.com:owner/repo.git',
          cloneUrlHttps: 'https://github.com/owner/repo.git',
        }),
        scanSkillsRepository: async (input) => {
          scanInput = input;
          return { ok: true, items: [] };
        },
      },
    });

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo', gitIdentityId: 'global' }),
    });
    expect(response.status).toBe(200);
    expect(scanInput.identity).toBeNull();
  });

  it('refuses to fall back when the selected account identity is unavailable', async () => {
    projectRoot = createTempProject();
    let scanned = false;
    appHandle = startSkillsApp({
      projectRoot,
      overrides: {
        getProfile: () => ({
          id: 'work',
          transport: 'account',
          account: { provider: 'github', instance: 'github.com', accountId: 'account-one' },
        }),
        resolveSourceControlAccount: async () => null,
        parseSkillRepoSource: () => ({
          ok: true,
          cloneUrlSsh: 'git@github.com:owner/private.git',
          cloneUrlHttps: 'https://github.com/owner/private.git',
        }),
        scanSkillsRepository: async () => {
          scanned = true;
          return { ok: true, items: [] };
        },
      },
    });

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/private', gitIdentityId: 'work' }),
    });
    expect(response.status).toBe(401);
    expect(scanned).toBe(false);
  });
});

describe('skill policy routes', () => {
  const cleanups = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const writeSkill = (root, relative, name) => {
    const file = path.join(root, relative, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`);
  };

  // A stand-in OpenCode serving what the routes read: its version, its config
  // documents (read from the files on every request, as a watching OpenCode
  // would), and the skills those documents leave enabled.
  const startOpenCodeStub = async ({ globalPath, projectPath, projectRoot, listEmpty, outage }) => {
    // OpenCode serves statements without the provenance key (measured on 2.0.25, 2.0.28, 2.0.29 and 2.0.30).
    const served = (info) => {
      const copy = { ...info };
      if (copy.policies) copy.policies = copy.policies.map(({ action, resource, effect }) => ({ action, resource, effect }));
      return copy;
    };
    // A file OpenCode cannot parse is left out of what it serves.
    const readDocuments = () => [globalPath, projectPath]
      .filter((file) => fs.existsSync(file))
      .flatMap((file) => {
        try {
          return [{ type: 'document', path: file, info: served(readConfigFile(file)) }];
        } catch {
          return [];
        }
      });
    const denied = () => new Set(readDocuments().flatMap((entry) => entry.info.policies ?? [])
      .filter((rule) => rule.effect === 'deny')
      .map((rule) => rule.resource.slice('skill:'.length)));
    const all = [
      { id: 'alpha-skill', name: 'Alpha Display', path: path.join(projectRoot, '.opencode', 'skills', 'alpha-skill', 'SKILL.md'), description: 'a' },
      { id: 'beta-one', name: 'Same Name', path: path.join(projectRoot, '.opencode', 'skills', 'beta-one', 'SKILL.md'), description: 'b1' },
      { id: 'beta-two', name: 'Same Name', path: path.join(projectRoot, '.opencode', 'skills', 'beta-two', 'SKILL.md'), description: 'b2' },
    ];
    const stub = express();
    // While `outage.down`, every read fails the way an unreachable OpenCode does.
    stub.use((_req, res, next) => (outage.down ? res.status(503).json({ error: 'down' }) : next()));
    stub.get('/api/info', (_req, res) => res.json({ version: '2.0.29', pid: 1, urls: [], paths: { tmp: os.tmpdir() } }));
    stub.get('/api/config', (_req, res) => res.json(readDocuments()));
    stub.get('/api/skill', (_req, res) => {
      const off = denied();
      res.json({ location: { directory: projectRoot }, data: listEmpty ? [] : all.filter((skill) => !off.has(skill.id)) });
    });
    const server = await new Promise((resolve) => {
      const started = stub.listen(0, () => resolve(started));
    });
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    return server.address().port;
  };

  const setupApp = async ({ listEmpty = false } = {}) => {
    const projectRoot = fs.realpathSync(createTempProject());
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-policy-global-'));
    cleanups.push(() => {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    });
    writeSkill(projectRoot, '.opencode/skills/alpha-skill', 'Alpha Display');
    writeSkill(projectRoot, '.opencode/skills/beta-one', 'Same Name');
    writeSkill(projectRoot, '.opencode/skills/beta-two', 'Same Name');
    const globalPath = path.join(configDir, 'opencode.json');
    const globalText = '{\n  "theme": "dark"\n}\n';
    fs.writeFileSync(globalPath, globalText);
    const projectPath = path.join(projectRoot, '.opencode', 'opencode.json');
    const outage = { down: false };
    const port = await startOpenCodeStub({ globalPath, projectPath, projectRoot, listEmpty, outage });
    const handle = startSkillsApp({
      projectRoot,
      overrides: {
        buildOpenCodeUrl: () => `http://127.0.0.1:${port}/`,
        getOpenCodePort: () => port,
        skillPolicyService: createSkillPolicyService({
          resolveTargets: (directory) => ({ global: globalPath, project: directory ? projectPath : null }),
          readConfigFile,
          writeConfig,
          sleep: async () => {},
        }),
      },
    });
    cleanups.push(() => handle.close());
    const query = `?directory=${encodeURIComponent(projectRoot)}`;
    const put = (body) => fetch(`${handle.baseUrl}/api/config/skill-policy${query}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const list = async () => (await fetch(`${handle.baseUrl}/api/config/skills${query}`)).json();
    return { projectRoot, baseUrl: handle.baseUrl, globalPath, globalText, projectPath, put, list, outage, lookup: handle.skillRoutes.readQueuedSkillPolicy };
  };

  it('answers queued deliveries by id, and by name with every skill sharing it', async () => {
    const { projectRoot, put, lookup } = await setupApp();
    expect((await put({ id: 'alpha-skill', scope: 'project', enabled: false })).status).toBe(200);

    const byId = await lookup({ directory: projectRoot, ids: ['alpha-skill', 'beta-one'], names: [] });
    expect(byId.inventory).toBeNull();
    expect(Object.fromEntries(byId.states)).toEqual({ 'alpha-skill': 'disabled', 'beta-one': 'enabled' });

    // OpenCode no longer lists the switched-off skill; the disk scan still
    // has it, so its name resolves to its id.
    const byName = await lookup({ directory: projectRoot, ids: [], names: ['Alpha Display', 'Same Name', 'gone'] });
    expect(byName.inventory).toEqual(expect.arrayContaining([
      { id: 'alpha-skill', name: 'Alpha Display' },
      { id: 'beta-one', name: 'Same Name' },
      { id: 'beta-two', name: 'Same Name' },
    ]));
    expect(Object.fromEntries(byName.states)).toEqual({ 'alpha-skill': 'disabled', 'beta-one': 'enabled', 'beta-two': 'enabled' });
  });

  it('keeps a skill known off while its project file cannot be parsed, and follows the file once it is valid again', async () => {
    const { projectRoot, projectPath, put, list, lookup } = await setupApp();
    expect((await put({ id: 'alpha-skill', scope: 'project', enabled: false })).status).toBe(200);
    const validText = fs.readFileSync(projectPath, 'utf8');
    const queued = async () => Object.fromEntries((await lookup({ directory: projectRoot, ids: ['alpha-skill'], names: [] })).states);
    expect(await queued()).toEqual({ 'alpha-skill': 'disabled' });

    // OpenCode still answers, without the broken file and so without its deny.
    fs.writeFileSync(projectPath, `${validText.trimEnd().slice(0, -1)} oops }`);
    const listed = await list();
    expect(listed.skillPolicy.effectiveAvailable).toBe(true);
    expect(listed.skillPolicy.scopes.project.error).toMatch(/invalid JSONC/);
    expect(byId(listed.skillPolicy).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: null }, effective: 'unknown', decidedBy: null });
    expect(await queued()).toEqual({ 'alpha-skill': 'disabled' });

    fs.writeFileSync(projectPath, validText);
    expect(await queued()).toEqual({ 'alpha-skill': 'disabled' });
    expect((await put({ id: 'alpha-skill', scope: 'project', enabled: true })).status).toBe(200);
    expect(await queued()).toEqual({ 'alpha-skill': 'enabled' });
  });

  it('keeps the last known state through an OpenCode outage and never counts the failure as a state', async () => {
    const { projectRoot, put, lookup, outage } = await setupApp();
    expect((await put({ id: 'alpha-skill', scope: 'project', enabled: false })).status).toBe(200);

    outage.down = true;
    const during = await lookup({ directory: projectRoot, ids: ['alpha-skill', 'beta-one'], names: ['Same Name'] });
    // The switch reported alpha-skill off; nothing was ever reported for
    // beta-one, so it stays unknown, and the names cannot be resolved.
    expect(Object.fromEntries(during.states)).toEqual({ 'alpha-skill': 'disabled' });
    expect(during.inventory).toBeNull();

    outage.down = false;
    expect((await put({ id: 'alpha-skill', scope: 'project', enabled: true })).status).toBe(200);
    outage.down = true;
    expect(Object.fromEntries((await lookup({ directory: projectRoot, ids: ['alpha-skill'], names: [] })).states)).toEqual({ 'alpha-skill': 'enabled' });
  });

  it('leaves a skill switched off after queueing out of the server queue delivery', async () => {
    const { projectRoot, put, lookup } = await setupApp();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-queue-'));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const sent = [];
    // The queue's own OpenCode calls: idle session, empty tail, accepted sends.
    const queueFetch = async (url, init = {}) => {
      const { pathname } = new URL(url);
      if (pathname === '/api/session/active') return Response.json({ data: {} });
      if (pathname.endsWith('/message')) return Response.json({ data: [], cursor: {} });
      if (init.method === 'POST' && (pathname.endsWith('/model') || pathname.endsWith('/agent'))) return new Response(null, { status: 204 });
      if (init.method === 'POST') {
        sent.push({ path: pathname, body: JSON.parse(init.body) });
        return Response.json({ data: { id: `msg_${sent.length}` } });
      }
      return new Response('not found', { status: 404 });
    };
    let onEvent = () => {};
    const queue = createMessageQueueRuntime({
      globalEventHub: { subscribeEvent: (handler) => { onEvent = handler; return () => {}; }, subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      readQueuedSkillPolicy: lookup,
      dataDir,
      fetchImpl: queueFetch,
      dispatchQuietMs: 0,
    });
    cleanups.push(() => queue.stop());
    queue.start();
    const instruction = 'The user explicitly mentioned these skills in their message: $Alpha Display, $Same Name. Use the corresponding skill tool when it is relevant to accomplishing the user\'s request.';
    queue.setHold('ses_skill_queue', true, 60_000);
    await queue.enqueue('ses_skill_queue', projectRoot, {
      content: 'go',
      text: 'go',
      attachments: [],
      context: [{ kind: 'instruction', text: instruction, skills: [{ id: 'alpha-skill', name: 'Alpha Display' }, { id: 'beta-one', name: 'Same Name' }] }],
      sendConfig: { providerID: 'p', modelID: 'm' },
    });

    expect((await put({ id: 'alpha-skill', scope: 'project', enabled: false })).status).toBe(200);
    queue.setHold('ses_skill_queue', false);
    const translated = { type: 'session.status', properties: { sessionID: 'ses_skill_queue', status: { type: 'idle' } } };
    onEvent({ payload: translated, directory: projectRoot, translated: () => [translated] });
    await vi.waitFor(() => expect(sent.map((entry) => entry.path)).toContain('/api/session/ses_skill_queue/prompt'));

    expect(sent.map((entry) => entry.body)).toEqual([
      { text: instruction.replace('$Alpha Display, ', ''), resume: false },
      { text: 'go' },
    ]);
  });

  it('lists skills by OpenCode id, switches one off and on in the project, and keeps it listed while off', async () => {
    const { globalPath, globalText, projectPath, put, list } = await setupApp();

    const before = await list();
    const ids = before.skills.map((skill) => skill.id);
    expect(ids).toEqual(expect.arrayContaining(['alpha-skill', 'beta-one', 'beta-two']));
    expect(before.skills.filter((skill) => skill.name === 'Same Name').map((skill) => skill.id).sort()).toEqual(['beta-one', 'beta-two']);
    expect(before.skillPolicy).toMatchObject({ version: '2.0.29', location: 'policies', writable: true, effectiveAvailable: true });
    expect(byId(before.skillPolicy).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: false }, effective: 'enabled', decidedBy: null });

    // The display name is not an id OpenCode policies know.
    const byName = await put({ id: 'Alpha Display', scope: 'project', enabled: false });
    expect(byName.status).toBe(404);
    expect(fs.existsSync(projectPath)).toBe(false);

    const off = await put({ id: 'alpha-skill', scope: 'project', enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      ok: true,
      id: 'alpha-skill',
      saved: { scope: 'project', path: projectPath, disabled: true, changed: true },
      confirmed: true,
      policy: { effective: 'disabled', decidedBy: { scope: 'project', owned: true } },
    });
    expect(readConfigFile(projectPath)).toEqual({
      policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny', openchamber: 'skill-switch' }],
    });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(globalText);

    const whileOff = await list();
    const alpha = whileOff.skills.find((skill) => skill.id === 'alpha-skill');
    expect(alpha).toMatchObject({ name: 'Alpha Display', scope: 'project' });
    expect(byId(whileOff.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });

    const on = await put({ id: 'alpha-skill', scope: 'project', enabled: true });
    expect(await on.json()).toMatchObject({ ok: true, confirmed: true, saved: { disabled: false, changed: true }, policy: { effective: 'enabled' } });
    expect(readConfigFile(projectPath)).toEqual({ policies: [] });
  });

  it('switches a skill off globally and reports the project switch as overridden', async () => {
    const { globalPath, put } = await setupApp();
    expect((await put({ id: 'beta-one', scope: 'global', enabled: false })).status).toBe(200);
    expect(readConfigFile(globalPath)).toEqual({
      theme: 'dark',
      policies: [{ action: 'integration.use', resource: 'skill:beta-one', effect: 'deny', openchamber: 'skill-switch' }],
    });

    const project = await (await put({ id: 'beta-one', scope: 'project', enabled: true })).json();
    expect(project).toMatchObject({
      ok: true,
      saved: { changed: false },
      policy: { disabledIn: { global: true, project: false }, effective: 'disabled', decidedBy: { scope: 'global', owned: true } },
    });
  });

  it('keeps two switched-off ids that share a display name listed and switchable when OpenCode lists none', async () => {
    const { projectPath, put, list } = await setupApp({ listEmpty: true });
    for (const id of ['beta-one', 'beta-two']) {
      expect((await put({ id, scope: 'project', enabled: false })).status).toBe(200);
    }

    const listed = await list();
    const sameName = listed.skills.filter((skill) => skill.name === 'Same Name');
    expect(sameName.map((skill) => skill.id).sort()).toEqual(['beta-one', 'beta-two']);
    expect(byId(listed.skillPolicy).get('beta-one')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
    expect(byId(listed.skillPolicy).get('beta-two')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });

    for (const id of ['beta-one', 'beta-two']) {
      expect(await (await put({ id, scope: 'project', enabled: true })).json()).toMatchObject({ ok: true, saved: { changed: true } });
    }
    expect(readConfigFile(projectPath)).toEqual({ policies: [] });
  });

  describe('renaming a switched-off skill keeps it off (#3075 decision)', () => {
    const ownedDeny = (id) => ({ action: 'integration.use', resource: `skill:${id}`, effect: 'deny', openchamber: 'skill-switch' });
    const userDeny = (resource) => ({ action: 'integration.use', resource, effect: 'deny' });
    const renameUrl = (app, name, { id } = {}) => {
      const query = new URLSearchParams({ directory: app.projectRoot });
      if (id) query.set('id', id);
      return `${app.baseUrl}/api/config/skills/${encodeURIComponent(name)}?${query}`;
    };
    const rename = (app, name, renameTo, options) => fetch(renameUrl(app, name, options), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renameTo }),
    });
    const setup = (options) => setupApp(options);
    const skillDir = (app, ...parts) => path.join(app.projectRoot, '.opencode', 'skills', ...parts);

    it('moves a project switch to the new id and the queue reads it as off', async () => {
      const app = await setup();
      expect((await app.put({ id: 'beta-two', scope: 'project', enabled: false })).status).toBe(200);
      const betaOne = fs.readFileSync(path.join(skillDir(app, 'beta-one'), 'SKILL.md'), 'utf8');

      const response = await rename(app, 'Same Name', 'beta-renamed', { id: 'beta-two' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: 'beta-renamed',
        switches: {
          carried: [{ scope: 'project', path: app.projectPath }],
          oldRuleRemoved: [{ scope: 'project', path: app.projectPath }],
          oldRuleKept: [],
          oldRuleCleanupFailed: [],
        },
      });
      expect(readConfigFile(app.projectPath)).toEqual({ policies: [ownedDeny('beta-renamed')] });
      expect(fs.readFileSync(app.globalPath, 'utf8')).toBe(app.globalText);
      expect(fs.readFileSync(path.join(skillDir(app, 'beta-one'), 'SKILL.md'), 'utf8')).toBe(betaOne);

      const listed = await app.list();
      expect(listed.skills.map((skill) => skill.id)).toContain('beta-renamed');
      expect(byId(listed.skillPolicy).get('beta-renamed')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
      // No switch rule is left for the old id (the stub's skill list still names it).
      expect(byId(listed.skillPolicy).get('beta-two')?.disabledIn.project ?? false).toBe(false);

      const queued = await app.lookup({ directory: app.projectRoot, ids: ['beta-renamed'], names: [] });
      expect(queued.states.get('beta-renamed')).toBe('disabled');
    });

    it('moves a global switch on a rename by display name, keeping the rest of the file', async () => {
      const app = await setup();
      expect((await app.put({ id: 'alpha-skill', scope: 'global', enabled: false })).status).toBe(200);

      const response = await rename(app, 'Alpha Display', 'alpha-renamed');
      expect(response.status).toBe(200);
      expect((await response.json()).switches.carried).toEqual([{ scope: 'global', path: app.globalPath }]);
      expect(readConfigFile(app.globalPath)).toEqual({ theme: 'dark', policies: [ownedDeny('alpha-renamed')] });
      expect(fs.existsSync(app.projectPath)).toBe(false);
    });

    it('moves switches in both scopes and leaves user-written rules exactly as they were', async () => {
      const app = await setup();
      const projectRules = [userDeny('skill:beta-one'), userDeny('skill:zz-*'), ownedDeny('beta-one')];
      fs.writeFileSync(app.projectPath, JSON.stringify({ experimental: { policies: projectRules } }, null, 2));
      expect((await app.put({ id: 'beta-one', scope: 'global', enabled: false })).status).toBe(200);

      const response = await rename(app, 'Same Name', 'beta-uno', { id: 'beta-one' });
      expect(response.status).toBe(200);
      // The project rule was in experimental.policies (2.0.25-2.0.28 format): the new one goes there too.
      expect(readConfigFile(app.projectPath)).toEqual({
        experimental: { policies: [userDeny('skill:beta-one'), userDeny('skill:zz-*'), ownedDeny('beta-uno')] },
      });
      expect(readConfigFile(app.globalPath)).toEqual({ theme: 'dark', policies: [ownedDeny('beta-uno')] });
    });

    it('keeps the old switch while another copy of the old id stays installed', async () => {
      const app = await setup();
      writeSkill(app.projectRoot, '.claude/skills/beta-two', 'Beta Copy');
      expect((await app.put({ id: 'beta-two', scope: 'project', enabled: false })).status).toBe(200);

      const response = await rename(app, 'Same Name', 'beta-renamed', { id: 'beta-two' });
      expect(response.status).toBe(200);
      expect((await response.json()).switches).toMatchObject({ oldRuleRemoved: [], oldRuleKept: [{ scope: 'project' }] });
      expect(readConfigFile(app.projectPath)).toEqual({ policies: [ownedDeny('beta-two'), ownedDeny('beta-renamed')] });
      expect(fs.existsSync(path.join(app.projectRoot, '.claude', 'skills', 'beta-two', 'SKILL.md'))).toBe(true);
    });

    it('carries the switch of a skill in a nested group folder', async () => {
      const app = await setup();
      writeSkill(app.projectRoot, '.opencode/skills/group/nested-skill', 'Nested Display');
      fs.writeFileSync(app.projectPath, JSON.stringify({ policies: [ownedDeny('nested-skill')] }));

      const response = await rename(app, 'Nested Display', 'nested-new');
      expect(response.status).toBe(200);
      expect(fs.existsSync(path.join(skillDir(app, 'group', 'nested-new'), 'SKILL.md'))).toBe(true);
      expect(readConfigFile(app.projectPath)).toEqual({ policies: [ownedDeny('nested-new')] });
    });

    it('refuses the rename, moving nothing, when a scope file cannot be read', async () => {
      const app = await setup();
      expect((await app.put({ id: 'beta-two', scope: 'project', enabled: false })).status).toBe(200);
      const projectBefore = fs.readFileSync(app.projectPath, 'utf8');
      fs.writeFileSync(app.globalPath, '{ broken');

      const response = await rename(app, 'Same Name', 'beta-renamed', { id: 'beta-two' });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/not renamed/);
      expect(fs.existsSync(path.join(skillDir(app, 'beta-two'), 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(skillDir(app, 'beta-renamed'))).toBe(false);
      expect(fs.readFileSync(app.projectPath, 'utf8')).toBe(projectBefore);
    });

    it.skipIf(process.getuid?.() === 0)('refuses the rename, moving nothing, when the switch cannot be written', async () => {
      const app = await setup();
      expect((await app.put({ id: 'beta-two', scope: 'project', enabled: false })).status).toBe(200);
      const projectBefore = fs.readFileSync(app.projectPath, 'utf8');
      fs.chmodSync(app.projectPath, 0o444);
      cleanups.push(() => fs.chmodSync(app.projectPath, 0o644));

      const response = await rename(app, 'Same Name', 'beta-renamed', { id: 'beta-two' });
      expect(response.status).toBe(500);
      expect((await response.json()).error).toMatch(/not renamed/);
      expect(fs.existsSync(path.join(skillDir(app, 'beta-two'), 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(app.projectPath, 'utf8')).toBe(projectBefore);
    });

    it.skipIf(process.getuid?.() === 0)('takes the carried switch out again when the folder cannot be moved', async () => {
      const app = await setup();
      expect((await app.put({ id: 'beta-two', scope: 'project', enabled: false })).status).toBe(200);
      const projectBefore = fs.readFileSync(app.projectPath, 'utf8');
      fs.chmodSync(skillDir(app), 0o555);
      cleanups.push(() => fs.chmodSync(skillDir(app), 0o755));

      const response = await rename(app, 'Same Name', 'beta-renamed', { id: 'beta-two' });
      expect(response.status).toBe(500);
      expect(fs.existsSync(path.join(skillDir(app, 'beta-two'), 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(app.projectPath, 'utf8')).toBe(projectBefore);
    });

    it('keeps both a switch flipped during a rename and the carried one', async () => {
      const app = await setup();
      expect((await app.put({ id: 'beta-two', scope: 'project', enabled: false })).status).toBe(200);

      const [renamed, toggled] = await Promise.all([
        rename(app, 'Same Name', 'beta-renamed', { id: 'beta-two' }),
        app.put({ id: 'alpha-skill', scope: 'project', enabled: false }),
      ]);
      expect(renamed.status).toBe(200);
      expect(toggled.status).toBe(200);
      const ids = readConfigFile(app.projectPath).policies.map((rule) => rule.resource).sort();
      expect(ids).toEqual(['skill:alpha-skill', 'skill:beta-renamed']);
    });
  });

  it('refuses a project switch without an explicit directory', async () => {
    const handle = startSkillsApp({ projectRoot: os.tmpdir() });
    cleanups.push(() => handle.close());
    const response = await fetch(`${handle.baseUrl}/api/config/skill-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'alpha-skill', scope: 'project', enabled: false }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('directory_required');
  });
});

describe('skill routes selected by OpenCode id', () => {
  const cleanups = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const write = (root, relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const skillMd = (name, body) => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

  // Two ids share the display name "Same Name" (one nested in a group folder,
  // with a different body and supporting file), and one id differs from its
  // display name. OpenCode is not running, so the disk scan is the listing.
  const setup = () => {
    const root = fs.realpathSync(createTempProject());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-id-data-'));
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    cleanups.push(() => {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const files = {
      one: write(root, '.opencode/skills/beta-one/SKILL.md', skillMd('Same Name', 'Body one')),
      oneNotes: write(root, '.opencode/skills/beta-one/notes.md', 'notes one'),
      two: write(root, '.opencode/skills/group/beta-two/SKILL.md', skillMd('Same Name', 'Body two')),
      twoNotes: write(root, '.opencode/skills/group/beta-two/notes.md', 'notes two'),
      display: write(root, '.opencode/skills/display-id/SKILL.md', skillMd('Display Name', 'Display body')),
    };
    const handle = startSkillsApp({ projectRoot: root });
    cleanups.push(() => handle.close());
    const url = (name, { id, suffix = '' } = {}) => {
      const query = new URLSearchParams({ directory: root });
      if (id !== undefined) query.set('id', id);
      return `${handle.baseUrl}/api/config/skills/${encodeURIComponent(name)}${suffix}?${query}`;
    };
    const call = (method, target, body) => fetch(target, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { root, files, url, call };
  };

  it('reads the exact skill an id names and never another with the same display name', async () => {
    const { files, url } = setup();

    const one = await (await fetch(url('Same Name', { id: 'beta-one' }))).json();
    expect(one).toMatchObject({ name: 'Same Name', id: 'beta-one', path: files.one });
    expect(one.sources.md.instructions.trim()).toBe('Body one');
    expect(one.sources.md.supportingFiles.map((file) => file.path)).toEqual(['notes.md']);

    const two = await (await fetch(url('Same Name', { id: 'beta-two' }))).json();
    expect(two).toMatchObject({ id: 'beta-two', path: files.two });
    expect(two.sources.md.instructions.trim()).toBe('Body two');

    const display = await (await fetch(url('Display Name', { id: 'display-id' }))).json();
    expect(display).toMatchObject({ id: 'display-id', path: files.display });

    expect((await fetch(url('Same Name', { id: 'display-id' }))).status).toBe(404);
    expect((await fetch(url('Same Name', { id: 'missing' }))).status).toBe(404);
    expect((await fetch(url('Same Name', { id: 'bad*id' }))).status).toBe(400);

    // Without `?id=` the display-name lookup still answers, and says which file it chose.
    const legacy = await (await fetch(url('Display Name'))).json();
    expect(legacy).toMatchObject({ id: 'display-id', path: files.display });
  });

  it('reads, writes and deletes supporting files of the selected skill only', async () => {
    const { files, url, call } = setup();

    const read = await (await fetch(url('Same Name', { id: 'beta-two', suffix: '/files/notes.md' }))).json();
    expect(read).toEqual({ path: 'notes.md', content: 'notes two' });

    expect((await call('PUT', url('Same Name', { id: 'beta-two', suffix: '/files/notes.md' }), { content: 'edited two' })).status).toBe(200);
    expect(fs.readFileSync(files.twoNotes, 'utf8')).toBe('edited two');
    expect(fs.readFileSync(files.oneNotes, 'utf8')).toBe('notes one');

    expect((await call('DELETE', url('Same Name', { id: 'beta-one', suffix: '/files/notes.md' }))).status).toBe(200);
    expect(fs.existsSync(files.oneNotes)).toBe(false);
    expect(fs.existsSync(files.twoNotes)).toBe(true);

    // A path that climbs out of the selected skill reaches neither skill.
    const escape = await fetch(url('Same Name', { id: 'beta-one', suffix: `/files/${encodeURIComponent('../group/beta-two/notes.md')}` }));
    expect(escape.status).toBe(403);
    expect(fs.readFileSync(files.twoNotes, 'utf8')).toBe('edited two');
  });

  it('updates the selected skill only and refuses a target path that is not it', async () => {
    const { root, files, url, call } = setup();

    const updated = await call('PATCH', url('Same Name', { id: 'beta-two' }), { instructions: 'New body two' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: 'beta-two', path: files.two });
    expect(fs.readFileSync(files.two, 'utf8')).toContain('New body two');
    expect(fs.readFileSync(files.one, 'utf8')).toContain('Body one');

    const mismatch = await call('PATCH', url('Same Name', { id: 'beta-two' }), { instructions: 'x', targetPath: files.one });
    expect(mismatch.status).toBe(409);
    expect(fs.readFileSync(files.one, 'utf8')).toContain('Body one');

    // Without `?id=`, a targetPath must still be a known skill file.
    const outside = write(root, 'elsewhere/SKILL.md', skillMd('Same Name', 'Outside'));
    const arbitrary = await call('PATCH', url('Same Name'), { instructions: 'x', targetPath: outside });
    expect(arbitrary.status).toBe(400);
    expect(fs.readFileSync(outside, 'utf8')).toContain('Outside');
  });

  it('renames the selected nested skill, whose folder and so its id take the new name', async () => {
    const { root, files, url, call } = setup();

    const renamed = await call('PATCH', url('Same Name', { id: 'beta-two' }), { renameTo: 'beta-renamed' });
    expect(renamed.status).toBe(200);
    const newPath = path.join(root, '.opencode', 'skills', 'group', 'beta-renamed', 'SKILL.md');
    expect(await renamed.json()).toMatchObject({ name: 'beta-renamed', id: 'beta-renamed', path: newPath });
    expect(fs.readFileSync(newPath, 'utf8')).toContain('Body two');
    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'group', 'beta-renamed', 'notes.md'))).toBe(true);
    expect(fs.existsSync(files.two)).toBe(false);
    expect(fs.readFileSync(files.one, 'utf8')).toContain('name: Same Name');

    // A new name that is another skill's id is refused and nothing moves.
    const clash = await call('PATCH', url('Display Name', { id: 'display-id' }), { renameTo: 'beta-one' });
    expect(clash.status).toBe(500);
    expect(fs.existsSync(files.display)).toBe(true);
  });

  it('deletes exactly the selected skill folder, nested ones included, and its own install record', async () => {
    const { root, files, url, call } = setup();
    const { appendInstalledSources, readInstalledSources } = await import('../skills-catalog/installed-sources.js');
    appendInstalledSources([
      { skillName: 'beta-one', skillDir: 'skills/beta-one', sourceId: 'acme' },
      { skillName: 'beta-two', skillDir: 'skills/beta-two', sourceId: 'acme' },
    ]);

    const removed = await call('DELETE', url('Same Name', { id: 'beta-two' }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: 'beta-two', path: files.two });
    expect(fs.existsSync(path.dirname(files.two))).toBe(false);
    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'group'))).toBe(true);
    expect(fs.readFileSync(files.one, 'utf8')).toContain('Body one');
    expect([...readInstalledSources().keys()]).toEqual(['beta-one']);

    expect((await call('DELETE', url('Same Name', { id: 'beta-two' }))).status).toBe(404);
    expect(fs.existsSync(files.one)).toBe(true);
  });
});

describe('skill-routes delete location', () => {
  /** @type {string | null} */
  let projectRoot = null;
  /** @type {{ close: () => Promise<void> } | null} */
  let appHandle = null;

  afterEach(async () => {
    if (appHandle) {
      await appHandle.close();
      appHandle = null;
    }
    if (projectRoot) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = null;
    }
  });

  const writeProjectSkill = (root, folder, name) => {
    const dir = path.join(root, folder, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nBody\n`);
    return dir;
  };

  it('deletes only the copy at the given scope and source', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });
    const agentsCopy = writeProjectSkill(projectRoot, '.agents', 'located-skill');
    const claudeCopy = writeProjectSkill(projectRoot, '.claude', 'located-skill');
    const query = `directory=${encodeURIComponent(projectRoot)}`;

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/located-skill?${query}&scope=project&source=agents`, { method: 'DELETE' });

    expect(response.ok).toBe(true);
    expect(fs.existsSync(agentsCopy)).toBe(false);
    expect(fs.existsSync(claudeCopy)).toBe(true);
  });

  it('deletes the located folder named by the id, whichever copy of the id is listed', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });
    const agentsCopy = path.join(projectRoot, '.agents', 'skills', 'vendor-folder');
    const claudeCopy = path.join(projectRoot, '.claude', 'skills', 'vendor-folder');
    for (const dir of [agentsCopy, claudeCopy]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Vendor Skill\ndescription: test\n---\nBody\n');
    }
    const query = `directory=${encodeURIComponent(projectRoot)}&id=vendor-folder`;

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/${encodeURIComponent('Vendor Skill')}?${query}&scope=project&source=claude`, { method: 'DELETE' });

    expect(response.ok).toBe(true);
    expect(fs.existsSync(claudeCopy)).toBe(false);
    expect(fs.existsSync(agentsCopy)).toBe(true);
  });

  it('fails without touching other copies when the given location has none', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });
    const claudeCopy = writeProjectSkill(projectRoot, '.claude', 'elsewhere-skill');
    const query = `directory=${encodeURIComponent(projectRoot)}`;

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/elsewhere-skill?${query}&scope=project&source=opencode`, { method: 'DELETE' });

    expect(response.ok).toBe(false);
    expect(fs.existsSync(claudeCopy)).toBe(true);
  });

  it('rejects an unknown location', async () => {
    projectRoot = createTempProject();
    appHandle = startSkillsApp({ projectRoot });

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/any-skill?scope=user&source=elsewhere`, { method: 'DELETE' });

    expect(response.status).toBe(400);
  });
});
