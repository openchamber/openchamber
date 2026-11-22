import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMagicPromptRuntime, createProjectMagicPromptRuntime } from './runtime.js';
import * as realFs from 'node:fs/promises';


const temporaryDirectories = [];

let dataDir;
let filePath;
let warnSpy;

const makeDataDir = async () => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-magic-prompts-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createRuntime = (fsOverrides = {}) => createMagicPromptRuntime({
  fsPromises: { ...fsPromises, ...fsOverrides },
  path,
  filePath,
});

beforeEach(async () => {
  dataDir = await makeDataDir();
  filePath = path.join(dataDir, 'magic-prompts.json');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsPromises.rm(directory, { recursive: true, force: true })));
});

describe('magic prompts runtime', () => {
  it('returns an empty state for a missing file, with no warning and no backup', async () => {
    const runtime = createRuntime();

    await expect(runtime.readPromptState()).resolves.toEqual({ version: 1, overrides: {} });
    expect(warnSpy).not.toHaveBeenCalled();
    await expect(fsPromises.readdir(dataDir)).resolves.toEqual([]);
  });

  it('round trips set, reset and reset-all through the real file', async () => {
    const runtime = createRuntime();

    await runtime.setOverride('alpha.visible', 'Alpha prompt');
    await runtime.setOverride('beta.visible', 'Beta prompt');
    await expect(runtime.readPromptState()).resolves.toEqual({
      version: 1,
      overrides: { 'alpha.visible': 'Alpha prompt', 'beta.visible': 'Beta prompt' },
    });
    expect(JSON.parse(await fsPromises.readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: { 'alpha.visible': 'Alpha prompt', 'beta.visible': 'Beta prompt' },
    });

    await runtime.resetOverride('alpha.visible');
    await expect(runtime.readPromptState()).resolves.toEqual({
      version: 1,
      overrides: { 'beta.visible': 'Beta prompt' },
    });

    await runtime.resetAllOverrides();
    await expect(runtime.readPromptState()).resolves.toEqual({ version: 1, overrides: {} });
  });

  it('writes via a temp file in the same directory renamed into place, never directly to the final path', async () => {
    const writeTargets = [];
    const renameCalls = [];
    const runtime = createRuntime({
      writeFile: async (target, ...rest) => {
        writeTargets.push(target);
        return fsPromises.writeFile(target, ...rest);
      },
      rename: async (from, to) => {
        renameCalls.push([from, to]);
        return fsPromises.rename(from, to);
      },
    });

    await runtime.setOverride('alpha.visible', 'Alpha prompt');

    expect(writeTargets.length).toBeGreaterThan(0);
    expect(writeTargets).not.toContain(filePath);
    expect(writeTargets.every((target) => target.startsWith(`${filePath}.tmp-`))).toBe(true);
    expect(renameCalls).toEqual(writeTargets.map((target) => [target, filePath]));
    // No temp file is left behind once the rename lands.
    await expect(fsPromises.readdir(dataDir)).resolves.toEqual(['magic-prompts.json']);
  });

  it('removes the temp file and surfaces the error when the rename fails', async () => {
    const runtime = createRuntime({
      rename: async () => {
        throw new Error('rename failed');
      },
    });

    await expect(runtime.setOverride('alpha.visible', 'Alpha prompt')).rejects.toThrow('rename failed');
    await expect(fsPromises.readdir(dataDir)).resolves.toEqual([]);
  });

  // An unparseable store is reported, never preserved aside or replaced: the
  // user's only copy of the overrides stays where it is.
  it('refuses to read or overwrite an unparseable file, leaving its bytes untouched', async () => {
    const corrupt = '{"version":1,"overrides":{"alpha.visible":"Alp';
    await fsPromises.writeFile(filePath, corrupt, 'utf8');
    const runtime = createRuntime();

    await expect(runtime.readPromptState()).rejects.toThrow('not valid JSON');
    await expect(runtime.setOverride('gamma.visible', 'Gamma prompt')).rejects.toThrow('not valid JSON');
    await expect(fsPromises.readFile(filePath, 'utf8')).resolves.toBe(corrupt);
    await expect(fsPromises.readdir(dataDir)).resolves.toEqual(['magic-prompts.json']);
  });

  it('does not overwrite the live store after reading an empty snapshot', async () => {
    const runtime = createRuntime();
    await runtime.setOverride('alpha.visible', 'Alpha prompt');

    // A torn, empty read must not count as a missing store: the next
    // mutation would then replace the live overrides.
    let emptyPending = true;
    const emptyReadRuntime = createRuntime({
      readFile: async (target, ...rest) => {
        if (emptyPending && String(target) === filePath) {
          emptyPending = false;
          return '';
        }
        return fsPromises.readFile(target, ...rest);
      },
    });

    await expect(emptyReadRuntime.setOverride('beta.visible', 'Beta prompt')).rejects.toThrow();
    expect(JSON.parse(await fsPromises.readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: { 'alpha.visible': 'Alpha prompt' },
    });
  });
});

// ---- upstream tests ----

const createGlobalRuntime = async () => {
  const tempRoot = await realFs.mkdtemp(path.join(os.tmpdir(), 'oc-magic-prompts-'));
  const filePath = path.join(tempRoot, 'magic-prompts.json');
  const runtime = createMagicPromptRuntime({ fsPromises: realFs, path, filePath });
  return { tempRoot, filePath, runtime };
};

describe('global magic prompt runtime', () => {
  it('keeps unknown top-level keys, and the previous file when a rename fails', async () => {
    const tempRoot = await realFs.mkdtemp(path.join(os.tmpdir(), 'oc-magic-prompts-'));
    let failRename = false;
    const filePath = path.join(tempRoot, 'magic-prompts.json');
    const runtime = createMagicPromptRuntime({
      fsPromises: {
        ...realFs,
        rename: async (from, to) => {
          if (failRename) throw Object.assign(new Error('EXDEV: rename failed'), { code: 'EXDEV' });
          return realFs.rename(from, to);
        },
      },
      path,
      filePath,
    });
    try {
      await realFs.writeFile(filePath, JSON.stringify({ version: 1, overrides: { 'a.visible': 'A' }, futureKey: 1 }));
      await runtime.setOverride('b.instructions', '');
      const written = await realFs.readFile(filePath, 'utf8');
      expect(JSON.parse(written)).toEqual({ version: 1, overrides: { 'a.visible': 'A', 'b.instructions': '' }, futureKey: 1 });

      failRename = true;
      await expect(runtime.setOverride('c.visible', 'C')).rejects.toThrow('EXDEV');
      expect(await realFs.readFile(filePath, 'utf8')).toBe(written);
      expect(await realFs.readdir(tempRoot)).toEqual(['magic-prompts.json']);
    } finally {
      await realFs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts a built-in camelCase prompt id and round-trips it through the file', async () => {
    const { tempRoot, filePath, runtime } = await createGlobalRuntime();
    try {
      await runtime.setOverride('session.craftGoal.instructions', 'goal text');
      const state = await runtime.readPromptState();
      expect(state.overrides['session.craftGoal.instructions']).toBe('goal text');
      const written = JSON.parse(await realFs.readFile(filePath, 'utf8'));
      expect(written.overrides['session.craftGoal.instructions']).toBe('goal text');
    } finally {
      await realFs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps a hand-edited camelCase override when reading the global file', async () => {
    const { tempRoot, filePath, runtime } = await createGlobalRuntime();
    try {
      await realFs.writeFile(filePath, JSON.stringify({ version: 1, overrides: { 'session.reviewHandoff.visible': '' } }));
      const state = await runtime.readPromptState();
      expect(state.overrides['session.reviewHandoff.visible']).toBe('');
    } finally {
      await realFs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('project magic prompt runtime', () => {
  it('reads a project map with a camelCase id instead of marking the scope invalid', async () => {
    const projectRuntime = createProjectMagicPromptRuntime({
      projectConfigRuntime: {
        readSharedProjectFile: async () => ({
          status: 'ok',
          document: { magicPrompts: { 'session.craftGoal.instructions': 'project text' } },
        }),
      },
    });
    const state = await projectRuntime.readProjectState({ id: 'p1', path: '/repo' });
    expect(state).toEqual({ status: 'ok', overrides: { 'session.craftGoal.instructions': 'project text' } });
  });
});
