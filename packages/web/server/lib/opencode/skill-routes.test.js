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

const createTempProject = () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-routes-'));
  fs.mkdirSync(path.join(projectRoot, '.git'));
  return projectRoot;
};

const startSkillsApp = ({ projectRoot, overrides = {} }) => {
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
