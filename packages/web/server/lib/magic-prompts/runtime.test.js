import { describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';
import * as realFs from 'fs/promises';

import { createMagicPromptRuntime, createProjectMagicPromptRuntime } from './runtime.js';

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
