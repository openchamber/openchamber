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
  mergeDiscoveredSkills,
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

const startSkillsApp = ({ projectRoot }) => {
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
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources: () => [],
    getCacheKey: () => 'k',
    getCachedScan: () => null,
    setCachedScan: () => {},
    parseSkillRepoSource: () => ({ ok: false }),
    scanSkillsRepository: async () => ({ ok: false }),
    installSkillsFromRepository: async () => ({ ok: false }),
    scanClawdHubPage: async () => ({ ok: false }),
    installSkillsFromClawdHub: async () => ({ ok: false }),
    isClawdHubSource: () => false,
    getProfiles: () => [],
    getProfile: () => null,
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
});
