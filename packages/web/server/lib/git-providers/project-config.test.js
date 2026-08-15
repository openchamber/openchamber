import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-providers-project-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const {
  sanitizeProjectGitProviders,
  getProjectGitProviders,
  resolveProjectIdFromDirectory,
  getProjectProviderApiBaseUrl,
  getEffectiveProviderApiBaseUrl,
  saveProjectGitProviders,
  _clearResolveProjectIdCache,
} = await import('./project-config.js');
const { registerGitProviderRoutes } = await import('./routes.js');

const PROJECTS_DIR = path.join(TEMP_DATA_DIR, 'projects');
const SETTINGS_FILE = path.join(TEMP_DATA_DIR, 'settings.json');

const projectFile = (projectId) => path.join(PROJECTS_DIR, `${projectId}.json`);

const writeSettingsProjects = (projects) => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ projects }));
};

// Resolution results are cached for 60s; tests mutate settings.json between
// assertions, so reset the module-level cache before every test.
afterEach(() => {
  _clearResolveProjectIdCache();
  fs.rmSync(PROJECTS_DIR, { recursive: true, force: true });
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.unlinkSync(SETTINGS_FILE);
  }
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

describe('sanitizeProjectGitProviders', () => {
  test('keeps only known providers and strips detectUrls', () => {
    expect(sanitizeProjectGitProviders({
      github: { apiBaseUrl: 'github.example.com', detectUrls: ['github.example.com'] },
      gitlab: { apiBaseUrl: 'https://gitlab.example.com' },
      gitea: { detectUrls: ['gitea.example.com'] },
      bitbucket: { apiBaseUrl: 'https://bitbucket.example.com' },
    })).toEqual({
      github: { apiBaseUrl: 'https://github.example.com' },
      gitlab: { apiBaseUrl: 'https://gitlab.example.com' },
    });
  });

  test('normalizes apiBaseUrl with the same rules as config.js', () => {
    expect(sanitizeProjectGitProviders({
      github: { apiBaseUrl: 'github.example.com/api/v3/' },
    })).toEqual({
      github: { apiBaseUrl: 'https://github.example.com/api/v3' },
    });
    expect(sanitizeProjectGitProviders({ github: { apiBaseUrl: '' } })).toBeUndefined();
    expect(sanitizeProjectGitProviders({ github: { apiBaseUrl: '   ' } })).toBeUndefined();
  });

  test('returns undefined for empty or invalid payloads', () => {
    expect(sanitizeProjectGitProviders({})).toBeUndefined();
    expect(sanitizeProjectGitProviders(null)).toBeUndefined();
    expect(sanitizeProjectGitProviders('not-an-object')).toBeUndefined();
    expect(sanitizeProjectGitProviders([])).toBeUndefined();
    expect(getProjectGitProviders('proj_1')).toEqual({});
  });
});

describe('saveProjectGitProviders round-trip', () => {
  test('preserves unrelated keys and normalizes gitProviders', async () => {
    const existing = {
      version: 1,
      projectNotes: 'keep me',
      setupWorktree: { clone: 'git@github.com:org/repo.git' },
      scheduledTasks: [{ id: 'task_1', name: 'nightly', enabled: true }],
    };
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(projectFile('proj_1'), JSON.stringify(existing, null, 2));

    const saved = await saveProjectGitProviders('proj_1', {
      github: { apiBaseUrl: 'github.example.com' },
      gitlab: { apiBaseUrl: '' },
    });
    expect(saved).toEqual({ github: { apiBaseUrl: 'https://github.example.com' } });

    const onDisk = JSON.parse(fs.readFileSync(projectFile('proj_1'), 'utf8'));
    expect(onDisk.projectNotes).toBe('keep me');
    expect(onDisk.setupWorktree).toEqual(existing.setupWorktree);
    expect(onDisk.scheduledTasks).toEqual(existing.scheduledTasks);
    expect(onDisk.version).toBe(1);
    expect(onDisk.gitProviders).toEqual({ github: { apiBaseUrl: 'https://github.example.com' } });
  });

  test('creates the projects dir when missing', async () => {
    const saved = await saveProjectGitProviders('proj_new', {
      gitea: { apiBaseUrl: 'gitea.example.com' },
    });
    expect(saved).toEqual({ gitea: { apiBaseUrl: 'https://gitea.example.com' } });
    expect(fs.existsSync(projectFile('proj_new'))).toBe(true);
  });

  test('removes the gitProviders key when the payload sanitizes empty', async () => {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(projectFile('proj_1'), JSON.stringify({
      version: 1,
      projectNotes: 'keep me',
      gitProviders: { github: { apiBaseUrl: 'https://github.example.com' } },
    }));

    await saveProjectGitProviders('proj_1', { github: { apiBaseUrl: '' } });

    const onDisk = JSON.parse(fs.readFileSync(projectFile('proj_1'), 'utf8'));
    expect(onDisk.projectNotes).toBe('keep me');
    expect('gitProviders' in onDisk).toBe(false);
    expect(getProjectGitProviders('proj_1')).toEqual({});
  });
});

describe('resolveProjectIdFromDirectory', () => {
  test('matches the exact project path', () => {
    writeSettingsProjects([{ id: 'proj_root', path: '/home/user/proj' }]);
    expect(resolveProjectIdFromDirectory('/home/user/proj')).toBe('proj_root');
  });

  test('matches a worktree child path to the root project', () => {
    writeSettingsProjects([{ id: 'proj_root', path: '/home/user/proj' }]);
    expect(resolveProjectIdFromDirectory('/home/user/proj/.git/worktrees/feature')).toBe('proj_root');
  });

  test('longest matching project path wins', () => {
    writeSettingsProjects([
      { id: 'proj_root', path: '/home/user/proj' },
      { id: 'proj_nested', path: '/home/user/proj/sub' },
    ]);
    expect(resolveProjectIdFromDirectory('/home/user/proj/sub/work')).toBe('proj_nested');
    expect(resolveProjectIdFromDirectory('/home/user/proj/sub')).toBe('proj_nested');
    expect(resolveProjectIdFromDirectory('/home/user/proj/work')).toBe('proj_root');
  });

  test('normalizes trailing slashes and backslashes', () => {
    writeSettingsProjects([
      { id: 'proj_back', path: 'C:\\Users\\dev\\proj\\' },
      { id: 'proj_slash', path: '/home/user/proj/' },
    ]);
    expect(resolveProjectIdFromDirectory('C:\\Users\\dev\\proj')).toBe('proj_back');
    expect(resolveProjectIdFromDirectory('/home/user/proj/sub')).toBe('proj_slash');
  });

  test('falls back to the path-derived id when no project matches', () => {
    writeSettingsProjects([{ id: 'proj_root', path: '/home/user/proj' }]);
    const expected = `path_${Buffer.from('/home/other/x', 'utf8').toString('base64url')}`;
    expect(resolveProjectIdFromDirectory('/home/other/x')).toBe(expected);
    expect(resolveProjectIdFromDirectory('/home/user/proj2')).toBe(`path_${Buffer.from('/home/user/proj2', 'utf8').toString('base64url')}`);
  });

  test('returns null for empty input', () => {
    writeSettingsProjects([{ id: 'proj_root', path: '/home/user/proj' }]);
    expect(resolveProjectIdFromDirectory('')).toBeNull();
    expect(resolveProjectIdFromDirectory('   ')).toBeNull();
    expect(resolveProjectIdFromDirectory(undefined)).toBeNull();
    expect(resolveProjectIdFromDirectory(null)).toBeNull();
  });

  test('falls back to the path-derived id when the settings file is missing or malformed', () => {
    const expected = `path_${Buffer.from('/home/user/proj', 'utf8').toString('base64url')}`;
    expect(resolveProjectIdFromDirectory('/home/user/proj')).toBe(expected);
    fs.writeFileSync(SETTINGS_FILE, '{not-json');
    expect(resolveProjectIdFromDirectory('/home/user/proj')).toBe(expected);
  });

  // Git may not be installed in every environment; availability is checked once
  // and the worktree test is skipped when it is missing.
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!hasGit)('resolves an external git worktree (a sibling of the repo root) to its main repo project', () => {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitprov-main-'));
    const siblingParent = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitprov-sibling-'));
    const worktree = path.join(siblingParent, 'feature-wt');
    try {
      execFileSync('git', ['init', '-q', main]);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feature', worktree]);
      const mainRoot = path.resolve(main);
      const projectId = `path_${Buffer.from(mainRoot, 'utf8').toString('base64url')}`;
      writeSettingsProjects([{ id: projectId, path: mainRoot }]);
      expect(resolveProjectIdFromDirectory(worktree)).toBe(projectId);
      // A subdirectory of the worktree resolves the same way.
      const nested = path.join(worktree, 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });
      expect(resolveProjectIdFromDirectory(nested)).toBe(projectId);
    } finally {
      try {
        execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
      } catch {
        // already removed
      }
      fs.rmSync(siblingParent, { recursive: true, force: true });
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  test('resolves a subdirectory to a project whose path is the filesystem root /', () => {
    writeSettingsProjects([{ id: 'proj_rootfs', path: '/' }]);
    expect(resolveProjectIdFromDirectory('/tmp/somewhere/under')).toBe('proj_rootfs');
    expect(resolveProjectIdFromDirectory('/')).toBe('proj_rootfs');
    // A more specific registered path still wins over the root catch-all.
    _clearResolveProjectIdCache();
    writeSettingsProjects([
      { id: 'proj_rootfs', path: '/' },
      { id: 'proj_tmp', path: '/tmp' },
    ]);
    expect(resolveProjectIdFromDirectory('/tmp/somewhere/under')).toBe('proj_tmp');
  });

  test('serves the cached resolution within the TTL even after the settings change', () => {
    writeSettingsProjects([{ id: 'proj_first', path: '/cache/proj' }]);
    expect(resolveProjectIdFromDirectory('/cache/proj')).toBe('proj_first');
    writeSettingsProjects([{ id: 'proj_second', path: '/cache/proj' }]);
    expect(resolveProjectIdFromDirectory('/cache/proj')).toBe('proj_first');
  });
});

describe('getEffectiveProviderApiBaseUrl precedence', () => {
  const PROJECT_OVERRIDES = {
    github: { apiBaseUrl: 'https://project.github.example.com' },
  };

  test('project override beats the global settings value', () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      projects: [{ id: 'proj_1', path: '/home/user/proj' }],
      gitProviders: {
        github: { apiBaseUrl: 'https://global.github.example.com' },
        gitlab: { apiBaseUrl: 'https://global.gitlab.example.com' },
      },
    }));
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(projectFile('proj_1'), JSON.stringify({ gitProviders: PROJECT_OVERRIDES }));

    expect(getEffectiveProviderApiBaseUrl('github', '/home/user/proj')).toBe('https://project.github.example.com');
  });

  test('falls through to the global value when the project has no override for that provider', () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      projects: [{ id: 'proj_1', path: '/home/user/proj' }],
      gitProviders: { gitlab: { apiBaseUrl: 'https://global.gitlab.example.com' } },
    }));
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(projectFile('proj_1'), JSON.stringify({ gitProviders: PROJECT_OVERRIDES }));

    expect(getEffectiveProviderApiBaseUrl('github', '/home/user/proj')).toBe('https://project.github.example.com');
    expect(getEffectiveProviderApiBaseUrl('gitlab', '/home/user/proj')).toBe('https://global.gitlab.example.com');
  });

  test('falls through to the built-in default when neither project nor global is set', () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      projects: [{ id: 'proj_1', path: '/home/user/proj' }],
    }));
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(projectFile('proj_1'), JSON.stringify({ gitProviders: PROJECT_OVERRIDES }));

    expect(getEffectiveProviderApiBaseUrl('github', '/home/user/proj')).toBe('https://project.github.example.com');
    expect(getEffectiveProviderApiBaseUrl('gitea', '/home/user/proj')).toBe('https://codeberg.org');
  });

  test('applies the global value for a directory not registered as a project', () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      projects: [],
      gitProviders: { github: { apiBaseUrl: 'https://global.github.example.com' } },
    }));
    expect(getEffectiveProviderApiBaseUrl('github', '/home/unregistered/proj')).toBe('https://global.github.example.com');
    expect(getEffectiveProviderApiBaseUrl('gitea', '/home/unregistered/proj')).toBe('https://codeberg.org');
  });

  test('per-provider independence with no global settings file', () => {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(projectFile('proj_1'), JSON.stringify({ gitProviders: PROJECT_OVERRIDES }));
    expect(getProjectProviderApiBaseUrl('github', 'proj_1')).toBe('https://project.github.example.com');
    expect(getProjectProviderApiBaseUrl('gitlab', 'proj_1')).toBeNull();
    expect(getProjectProviderApiBaseUrl('github', 'missing_project')).toBeNull();
  });
});

describe('project git-providers routes', () => {
  const createApp = () => {
    const app = express();
    app.use(express.json());
    registerGitProviderRoutes(app);
    return app;
  };

  test('GET returns {} when nothing is set', async () => {
    const app = createApp();
    const response = await request(app).get('/api/projects/proj_1/git-providers');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ gitProviders: {} });
  });

  test('PUT persists and GET returns the saved overrides', async () => {
    const app = createApp();
    const putResponse = await request(app)
      .put('/api/projects/proj_1/git-providers')
      .send({ gitProviders: { github: { apiBaseUrl: 'github.example.com' } } });
    expect(putResponse.status).toBe(200);
    expect(putResponse.body).toEqual({ gitProviders: { github: { apiBaseUrl: 'https://github.example.com' } } });

    const getResponse = await request(app).get('/api/projects/proj_1/git-providers');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual({ gitProviders: { github: { apiBaseUrl: 'https://github.example.com' } } });

    // The saved value is readable via the direct module API too.
    expect(getProjectGitProviders('proj_1')).toEqual({ github: { apiBaseUrl: 'https://github.example.com' } });
  });

  test('PUT rejects an invalid body shape with 400', async () => {
    const app = createApp();
    expect((await request(app).put('/api/projects/proj_1/git-providers').send({})).status).toBe(400);
    expect((await request(app).put('/api/projects/proj_1/git-providers').send({ gitProviders: 'nope' })).status).toBe(400);
    expect((await request(app).put('/api/projects/proj_1/git-providers').send({ gitProviders: [] })).status).toBe(400);
    expect((await request(app).put('/api/projects/proj_1/git-providers').send({ gitProviders: null })).status).toBe(400);
  });

  test('PUT with an empty gitProviders object clears the stored overrides', async () => {
    const app = createApp();
    await request(app)
      .put('/api/projects/proj_1/git-providers')
      .send({ gitProviders: { github: { apiBaseUrl: 'github.example.com' } } });
    const putResponse = await request(app)
      .put('/api/projects/proj_1/git-providers')
      .send({ gitProviders: {} });
    expect(putResponse.status).toBe(200);
    expect(putResponse.body).toEqual({ gitProviders: {} });
    expect(getProjectGitProviders('proj_1')).toEqual({});
  });
});