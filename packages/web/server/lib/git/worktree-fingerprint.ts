import fs from 'node:fs';
import path from 'node:path';

import { assertPathReachable } from './reachable-disk.js';

export const readWorktreeTopologyFingerprint = async (repositoryKey: string) => {
  const worktreesDir = await assertPathReachable(path.join(repositoryKey, 'worktrees'));
  try {
    const stat = await fs.promises.stat(worktreesDir);
    const entries = await fs.promises.readdir(worktreesDir, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    const links = new Set(entries.filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name));
    const heads = await Promise.all(names.map(async (name) => {
      const folder = path.join(worktreesDir, name);
      if (links.has(name) && !await assertPathReachable(folder).catch(() => null)) return '';
      return fs.promises.readFile(path.join(folder, 'HEAD'), 'utf8').then((head) => head.trim(), () => '');
    }));
    return `${stat.mtimeMs}:${names.join('\0')}:${heads.join('\0')}`;
  } catch {
    return 'none';
  }
};
