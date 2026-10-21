import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as realFs from 'fs/promises';

import { createMagicPromptRuntime } from './runtime.js';

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
});
