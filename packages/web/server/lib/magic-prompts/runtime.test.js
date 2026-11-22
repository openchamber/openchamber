import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMagicPromptRuntime } from './runtime.js';

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

const warnText = () => warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');

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
    const writeModes = [];
    const renameCalls = [];
    const runtime = createRuntime({
      writeFile: async (target, ...rest) => {
        writeTargets.push(target);
        writeModes.push(rest[1]?.mode);
        return fsPromises.writeFile(target, ...rest);
      },
      rename: async (from, to) => {
        renameCalls.push([from, to]);
        return fsPromises.rename(from, to);
      },
    });

    await runtime.setOverride('alpha.visible', 'Alpha prompt');

    expect(writeTargets.length).toBeGreaterThan(0);
    expect(writeModes).toEqual([0o666]);
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

  it('preserves an unparseable file before a later write overwrites it, and the warning names the preserved path', async () => {
    const corrupt = '{"version":1,"overrides":{"alpha.visible":"Alp';
    await fsPromises.writeFile(filePath, corrupt, 'utf8');
    const runtime = createRuntime();

    await runtime.setOverride('gamma.visible', 'Gamma prompt');

    const files = await fsPromises.readdir(dataDir);
    const preserved = files.filter((name) => name.startsWith('magic-prompts.json.corrupt-'));
    expect(preserved).toHaveLength(1);
    await expect(fsPromises.readFile(path.join(dataDir, preserved[0]), 'utf8')).resolves.toBe(corrupt);
    expect(warnText()).toContain(preserved[0]);
    // The new state landed in the real file; the corrupt bytes are only in the backup.
    expect(JSON.parse(await fsPromises.readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: { 'gamma.visible': 'Gamma prompt' },
    });
  });

  it('returns an empty state for an unparseable file after preserving it', async () => {
    await fsPromises.writeFile(filePath, '{ not json', 'utf8');
    const runtime = createRuntime();

    await expect(runtime.readPromptState()).resolves.toEqual({ version: 1, overrides: {} });
    const files = await fsPromises.readdir(dataDir);
    expect(files.some((name) => name.startsWith('magic-prompts.json.corrupt-'))).toBe(true);
    expect(files).not.toContain('magic-prompts.json');
  });

  it('returns an empty state for an unparseable file when preservation fails on a read', async () => {
    await fsPromises.writeFile(filePath, '{ not json', 'utf8');
    const runtime = createRuntime({
      rename: async (from, to) => {
        if (String(to).includes('.corrupt-')) {
          throw new Error('preserve failed');
        }
        return fsPromises.rename(from, to);
      },
    });

    await expect(runtime.readPromptState()).resolves.toEqual({ version: 1, overrides: {} });
    await expect(fsPromises.readFile(filePath, 'utf8')).resolves.toBe('{ not json');
  });

  it('never preserves the valid file a concurrent write saved after a stale corrupt read', async () => {
    const corrupt = '{ not json';
    await fsPromises.writeFile(filePath, corrupt, 'utf8');
    const validState = { version: 1, overrides: { 'beta.visible': 'Beta prompt' } };
    let reads = 0;
    const renameCalls = [];
    const runtime = createRuntime({
      readFile: async (...args) => {
        reads += 1;
        if (reads === 1) {
          // The stale read that saw the corrupt bytes. The concurrent
          // write lands before this reader gets to preserve anything.
          await fsPromises.writeFile(filePath, JSON.stringify(validState), 'utf8');
          return corrupt;
        }
        return fsPromises.readFile(...args);
      },
      rename: async (from, to) => {
        renameCalls.push([from, to]);
        return fsPromises.rename(from, to);
      },
    });

    // The write's state is the answer, and the file it saved stays put:
    // no .corrupt-* rename may move it aside.
    await expect(runtime.readPromptState()).resolves.toEqual(validState);
    expect(renameCalls.filter(([, to]) => String(to).includes('.corrupt-'))).toEqual([]);
    await expect(fsPromises.readFile(filePath, 'utf8')).resolves.toBe(JSON.stringify(validState));
  });

  it('revalidates an empty snapshot before treating the store as missing (Codex, PR #1019 pattern)', async () => {
    const runtime = createRuntime();
    await runtime.setOverride('alpha.visible', 'Alpha prompt');

    // First read returns empty bytes (a torn/empty snapshot) while the
    // file on disk already holds the valid store written above:
    // treating that snapshot as a missing store would let the next
    // mutation overwrite the live overrides.
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

    await emptyReadRuntime.setOverride('beta.visible', 'Beta prompt');
    expect(JSON.parse(await fsPromises.readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: { 'alpha.visible': 'Alpha prompt', 'beta.visible': 'Beta prompt' },
    });
    expect((await fsPromises.readdir(dataDir)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });

  it('aborts a mutation when preserving the corrupt file fails, leaving its bytes untouched', async () => {
    const corrupt = '{"version":1,"overrides":{"alpha.visible":"Alp';
    await fsPromises.writeFile(filePath, corrupt, 'utf8');
    const runtime = createRuntime({
      rename: async (from, to) => {
        if (String(to).includes('.corrupt-')) {
          const error = new Error('resource busy or locked');
          error.code = 'EBUSY';
          throw error;
        }
        return fsPromises.rename(from, to);
      },
    });

    await expect(runtime.setOverride('gamma.visible', 'Gamma prompt')).rejects.toThrow('refusing to overwrite');
    // The only copy of the user's overrides is still exactly where it was.
    await expect(fsPromises.readFile(filePath, 'utf8')).resolves.toBe(corrupt);
    await expect(fsPromises.readdir(dataDir)).resolves.toEqual(['magic-prompts.json']);
  });
});
