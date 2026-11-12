// The agent works in the human's projects, which the human's account owns. git refuses a
// repository another account owns until that account trusts it with `safe.directory`, read only
// from its own global or system configuration. The agent server keeps its own global list in step
// with its registered projects: the project folder and the folder that holds its `.git`.
// Entries are only added: anything the agent's account put there itself stays.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// A project of the agent's settings, which come from its file: only one with an absolute path is trusted.
const projectSchema = z.object({ path: z.string().refine((folder) => path.isAbsolute(folder)) });

/** The folder of the repository a project sits in, or null outside one. */
const repositoryOf = async (directory) => {
  for (let current = directory; ; current = path.dirname(current)) {
    if (await fs.lstat(path.join(current, '.git')).then(() => true, () => false)) return current;
    if (path.dirname(current) === current) return null;
  }
};

/** The folders git checks the owner of for a registered project: the project and its repository's. */
export const trustedFolders = async (directory) => [...new Set([directory, await repositoryOf(directory)].filter(Boolean))];

/**
 * `runGit(args)` resolves `{ code, stdout }` for the agent's own git with its own global config.
 * Answers the folders it added.
 */
export async function trustProjectRepositories({ projects, runGit }) {
  const listed = await runGit(['config', '--global', '--get-all', 'safe.directory']);
  const trusted = new Set(listed.code === 0 ? listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []);
  const added = [];
  for (const project of projects) {
    const parsed = projectSchema.safeParse(project);
    if (!parsed.success) continue;
    for (const folder of await trustedFolders(parsed.data.path)) {
      if (trusted.has(folder) || trusted.has('*')) continue;
      const result = await runGit(['config', '--global', '--add', 'safe.directory', folder]);
      if (result.code !== 0) continue;
      trusted.add(folder);
      added.push(folder);
    }
  }
  return added;
}
