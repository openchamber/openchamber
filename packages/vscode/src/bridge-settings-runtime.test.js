import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: { activeColorTheme: { kind: 2 } },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrastDark: 3, HighContrastLight: 4 },
}));

// Keep any import-time config materialisation out of the real OpenChamber
// config, mirroring bridge-config-runtime.test.js.
const scratchConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-settings-'));
process.env.XDG_CONFIG_HOME = path.join(scratchConfigRoot, 'xdg');
process.env.OPENCODE_CONFIG_DIR = '';
// The magic-prompts (and shared settings) paths are derived from
// os.homedir() at import time, and Bun's os.homedir() ignores a HOME
// env var reassigned after process start — so mock the os module's
// homedir to scratch before importing instead: the tests below must
// never touch the real ~/.config/openchamber.
const scratchHome = path.join(scratchConfigRoot, 'home');
fs.mkdirSync(scratchHome, { recursive: true });
const realOs = { ...os };
const osWithScratchHome = { ...realOs, homedir: () => scratchHome, default: { ...realOs, homedir: () => scratchHome } };
mock.module('os', () => osWithScratchHome);
mock.module('node:os', () => osWithScratchHome);

const {
  fetchOpenCodeSkillsFromApi,
  readMagicPromptOverrides,
  readSettings,
  resetAllMagicPromptOverrides,
  resetMagicPromptOverride,
  saveMagicPromptOverride,
} = await import('./bridge-settings-runtime.ts');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createCtx = (workingDirectory) => ({
  manager: {
    getApiUrl: () => 'http://opencode.test',
    getWorkingDirectory: () => workingDirectory,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  },
});

const stubSkillListResponse = (data) => {
  const fetchMock = mock(async () =>
    new Response(JSON.stringify({ location: { directory: 'scratch' }, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
};

describe('fetchOpenCodeSkillsFromApi payload mapping', () => {
  test('reads the v2 `path` field, keeps the v1 `location` fallback, and drops unlocated items', async () => {
    const projectRoot = path.join(os.tmpdir(), `oc-vscode-skills-${Date.now()}`);
    const workspaces = [
      { id: 'v2-path-skill', name: 'v2-path-skill', path: path.join(projectRoot, '.agents', 'skills', 'v2-path-skill'), description: 'v2 path', content: 'content-v2' },
      { id: 'v1-location-skill', name: 'v1-location-skill', location: path.join(projectRoot, '.agents', 'skills', 'v1-location-skill'), description: 'v1 location', content: 'content-v1' },
      { id: 'builtin-skill', name: 'builtin-skill', path: '<built-in>', description: 'built-in' },
      { id: 'opencode', name: 'OpenCode', path: '/builtin/opencode.md', description: 'v2 built-in', content: 'builtin-content' },
      { id: 'unlocated-skill', name: 'unlocated-skill', description: 'no location at all' },
    ];
    const fetchMock = stubSkillListResponse(workspaces);

    const skills = await fetchOpenCodeSkillsFromApi(createCtx(projectRoot), projectRoot);

    expect(fetchMock).toHaveBeenCalled();
    expect(skills).not.toBeNull();
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    // OpenCode v2 payload: the item carries `path` instead of `location`.
    expect(byName.get('v2-path-skill')).toEqual({
      name: 'v2-path-skill',
      path: path.join(projectRoot, '.agents', 'skills', 'v2-path-skill'),
      scope: 'project',
      source: 'agents',
      description: 'v2 path',
      content: 'content-v2',
    });

    // OpenCode v1 payload: `location` is still accepted as the fallback.
    expect(byName.get('v1-location-skill')).toEqual({
      name: 'v1-location-skill',
      path: path.join(projectRoot, '.agents', 'skills', 'v1-location-skill'),
      scope: 'project',
      source: 'agents',
      description: 'v1 location',
      content: 'content-v1',
    });

    // Built-in skills keep the opencode source and user scope.
    expect(byName.get('builtin-skill')).toEqual({
      name: 'builtin-skill',
      path: '<built-in>',
      scope: 'user',
      source: 'opencode',
      description: 'built-in',
      content: '',
    });

    // OpenCode v2 built-ins carry a synthetic `/builtin/` path; normalize to the read-only marker.
    expect(byName.get('OpenCode')).toEqual({
      name: 'OpenCode',
      path: '<built-in>',
      scope: 'user',
      source: 'opencode',
      description: 'v2 built-in',
      content: 'builtin-content',
    });

    // Items with neither field are dropped, unchanged.
    expect(byName.has('unlocated-skill')).toBe(false);
  });

  test('returns null when the API responds with an error or a non-list payload', async () => {
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 }));
    expect(await fetchOpenCodeSkillsFromApi(createCtx('dir'), 'dir')).toBeNull();

    stubSkillListResponse({ not: 'an array' });
    expect(await fetchOpenCodeSkillsFromApi(createCtx('dir'), 'dir')).toBeNull();
  });

  test('returns null when the context exposes no API url', async () => {
    expect(await fetchOpenCodeSkillsFromApi({ manager: { getApiUrl: () => null } }, 'dir')).toBeNull();
  });
});

describe('fetchOpenCodeSkillsFromApi skill scope for subdirectory sessions', () => {
  const makeRepo = (gitKind) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-skill-scope-'));
    if (gitKind === 'directory') {
      fs.mkdirSync(path.join(repoRoot, '.git'));
    } else if (gitKind === 'file') {
      fs.writeFileSync(path.join(repoRoot, '.git'), 'gitdir: /elsewhere/worktrees/demo\n');
    }
    const workingDirectory = path.join(repoRoot, 'packages', 'foo');
    fs.mkdirSync(workingDirectory, { recursive: true });
    return { repoRoot, workingDirectory };
  };

  const skillsFor = async (workingDirectory, skillPaths) => {
    stubSkillListResponse(
      skillPaths.map((skillPath, index) => ({
        id: `skill-${index}`,
        name: `skill-${index}`,
        path: skillPath,
        description: `skill ${index}`,
        content: '',
      })),
    );
    const skills = await fetchOpenCodeSkillsFromApi(createCtx(workingDirectory), workingDirectory);
    return new Map(skills.map((skill) => [skill.path, skill]));
  };

  test('classifies repo-root skills as project when the working directory is a subdirectory of a normal repository (.git directory)', async () => {
    const { repoRoot, workingDirectory } = makeRepo('directory');
    const agentsSkill = path.join(repoRoot, '.agents', 'skills', 'demo-agents');
    const opencodeSkill = path.join(repoRoot, '.opencode', 'skills', 'demo-opencode');

    const byPath = await skillsFor(workingDirectory, [agentsSkill, opencodeSkill]);

    expect(byPath.get(agentsSkill)?.scope).toBe('project');
    expect(byPath.get(agentsSkill)?.source).toBe('agents');
    expect(byPath.get(opencodeSkill)?.scope).toBe('project');
    expect(byPath.get(opencodeSkill)?.source).toBe('opencode');
  });

  test('keeps classifying repo-root skills as project for a subdirectory of a linked worktree (.git file)', async () => {
    const { repoRoot, workingDirectory } = makeRepo('file');
    const agentsSkill = path.join(repoRoot, '.agents', 'skills', 'demo-agents');

    const byPath = await skillsFor(workingDirectory, [agentsSkill]);

    expect(byPath.get(agentsSkill)?.scope).toBe('project');
  });

  test('does not promote skills outside any repository: a parent directory without .git is not a project ancestor', async () => {
    const { repoRoot, workingDirectory } = makeRepo(null);
    const agentsSkill = path.join(repoRoot, '.agents', 'skills', 'demo-agents');

    const byPath = await skillsFor(workingDirectory, [agentsSkill]);

    expect(byPath.get(agentsSkill)?.scope).toBe('user');
  });
});

describe('magic prompt overrides store', () => {
  const magicDir = path.join(scratchHome, '.config', 'openchamber');
  const magicPath = path.join(magicDir, 'magic-prompts.json');
  const corruptSiblings = () =>
    fs.existsSync(magicDir) ? fs.readdirSync(magicDir).filter((name) => name.includes('.corrupt-')) : [];
  const tmpSiblings = () =>
    fs.existsSync(magicDir) ? fs.readdirSync(magicDir).filter((name) => name.includes('.tmp-')) : [];
  const cleanMagicStore = () => {
    fs.rmSync(magicDir, { recursive: true, force: true });
  };

  test('ENOENT yields an empty state silently with no backup', () => {
    cleanMagicStore();
    expect(readMagicPromptOverrides()).toEqual({ version: 1, overrides: {} });
    expect(corruptSiblings()).toEqual([]);
  });

  test('set / reset / reset-all round trips persist {version:1, overrides}', async () => {
    cleanMagicStore();
    await saveMagicPromptOverride('alpha.visible', 'alpha text');
    const afterTwo = await saveMagicPromptOverride('beta.visible', 'beta text');
    expect(afterTwo).toEqual({
      version: 1,
      overrides: { 'alpha.visible': 'alpha text', 'beta.visible': 'beta text' },
    });
    expect(JSON.parse(fs.readFileSync(magicPath, 'utf8'))).toEqual(afterTwo);
    expect(readMagicPromptOverrides()).toEqual(afterTwo);

    const afterReset = await resetMagicPromptOverride('alpha.visible');
    expect(afterReset.overrides).toEqual({ 'beta.visible': 'beta text' });

    const afterResetAll = await resetAllMagicPromptOverrides();
    expect(afterResetAll).toEqual({ version: 1, overrides: {} });
    expect(JSON.parse(fs.readFileSync(magicPath, 'utf8'))).toEqual({ version: 1, overrides: {} });
  });

  test('writes are atomic: no temp files are left behind and the file parses', async () => {
    cleanMagicStore();
    await saveMagicPromptOverride('alpha.visible', 'alpha text');
    expect(tmpSiblings()).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(magicPath, 'utf8'))).not.toThrow();
  });

  test('a corrupt file is preserved as a .corrupt sibling before any overwrite, and a later save does not destroy it', async () => {
    cleanMagicStore();
    await saveMagicPromptOverride('alpha.visible', 'alpha text');
    await saveMagicPromptOverride('beta.visible', 'beta text');
    // Simulate a torn write.
    const torn = '{"version":1,"overrides":{"alpha.visible":"alpha te';
    fs.writeFileSync(magicPath, torn);

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let afterTear;
    try {
      afterTear = readMagicPromptOverrides();
    } finally {
      console.warn = originalWarn;
    }
    expect(afterTear).toEqual({ version: 1, overrides: {} });
    expect(warnings.some((line) => line.includes(magicPath))).toBe(true);

    const preserved = corruptSiblings();
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(magicDir, preserved[0]), 'utf8')).toBe(torn);
    // The corrupt bytes were moved aside, not copied: the store is gone
    // until the next save recreates it.
    expect(fs.existsSync(magicPath)).toBe(false);

    await saveMagicPromptOverride('gamma.visible', 'gamma text');
    expect(JSON.parse(fs.readFileSync(magicPath, 'utf8'))).toEqual({
      version: 1,
      overrides: { 'gamma.visible': 'gamma text' },
    });
    // The preserved copy is still the only place the torn bytes live.
    expect(corruptSiblings()).toEqual(preserved);
    expect(fs.readFileSync(path.join(magicDir, preserved[0]), 'utf8')).toBe(torn);
  });

  test('reset-all on a corrupt file preserves it instead of silently overwriting it', async () => {
    cleanMagicStore();
    fs.mkdirSync(magicDir, { recursive: true });
    const torn = 'not json at all';
    fs.writeFileSync(magicPath, torn);

    await resetAllMagicPromptOverrides();

    const preserved = corruptSiblings();
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(magicDir, preserved[0]), 'utf8')).toBe(torn);
    expect(JSON.parse(fs.readFileSync(magicPath, 'utf8'))).toEqual({ version: 1, overrides: {} });
  });
});

describe('bounded shared-store reads (#1641)', () => {
  const configDir = path.join(scratchHome, '.config', 'openchamber');
  const settingsPath = path.join(configDir, 'settings.json');
  const preferencesPath = path.join(configDir, 'preferences.json');
  const magicPath = path.join(configDir, 'magic-prompts.json');
  const cleanStores = () => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.mkdirSync(configDir, { recursive: true });
  };

  test('small settings and preferences files read back merged as before', () => {
    cleanStores();
    fs.writeFileSync(settingsPath, JSON.stringify({ opencodeBinary: '/probe/oc-bin' }));
    fs.writeFileSync(
      preferencesPath,
      JSON.stringify({ version: 1, fields: { themeId: { value: 'nord', updatedAt: 100 } } }),
    );

    const merged = readSettings();
    expect(merged.opencodeBinary).toBe('/probe/oc-bin');
    expect(merged.themeId).toBe('nord');
  });

  test('an over-cap settings.json degrades to {} instead of being buffered whole', () => {
    cleanStores();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ opencodeBinary: '/probe/oc-bin', pad: 'x'.repeat(9 * 1024 * 1024) }),
    );

    const merged = readSettings();
    expect(merged.opencodeBinary).toBeUndefined();
  });

  test('an over-cap preferences.json withholds profile keys but leaves settings readable', () => {
    cleanStores();
    fs.writeFileSync(settingsPath, JSON.stringify({ opencodeBinary: '/probe/oc-bin' }));
    fs.writeFileSync(
      preferencesPath,
      JSON.stringify({ version: 1, fields: { themeId: { value: 'x'.repeat(5 * 1024 * 1024), updatedAt: 100 } } }),
    );

    const merged = readSettings();
    expect(merged.opencodeBinary).toBe('/probe/oc-bin');
    expect(merged.themeId).toBeUndefined();
  });

  test('a FIFO at the settings path returns promptly instead of blocking the host', () => {
    cleanStores();
    execFileSync('mkfifo', [settingsPath]);

    const merged = readSettings();
    expect(merged.opencodeBinary).toBeUndefined();
  });

  test('an over-cap magic-prompts.json reads as an empty store, is not preserved as corrupt, and refuses overwrite', async () => {
    cleanStores();
    const oversized = JSON.stringify({ version: 1, overrides: { 'alpha.visible': 'x'.repeat(5 * 1024 * 1024) } });
    fs.writeFileSync(magicPath, oversized);

    expect(readMagicPromptOverrides()).toEqual({ version: 1, overrides: {} });
    // The bytes are untouched and were not moved aside as corrupt.
    expect(fs.readFileSync(magicPath, 'utf8')).toBe(oversized);
    expect(fs.readdirSync(configDir).filter((name) => name.includes('.corrupt-'))).toEqual([]);

    await expect(saveMagicPromptOverride('beta.visible', 'beta text')).rejects.toThrow('Refusing to overwrite');
    expect(fs.readFileSync(magicPath, 'utf8')).toBe(oversized);

    // Once the file is readable again, saves work as before.
    fs.writeFileSync(magicPath, JSON.stringify({ version: 1, overrides: {} }));
    const saved = await saveMagicPromptOverride('beta.visible', 'beta text');
    expect(saved.overrides).toEqual({ 'beta.visible': 'beta text' });
  });
});
