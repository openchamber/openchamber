import type { GitCommandResult } from './service-contracts.js';

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>;

const readCommits = async (runGit: RunGit, directory: string, revisions: string[]) => {
  const result = await runGit(directory, ['log', '--no-show-signature', '--format=%H%x00%an%x00%ae%x00%at%x00%s', ...revisions, '--']);
  if (!result.success) {
    throw new Error(result.message || 'Failed to read the integrated commits');
  }
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha = '', name = '', email = '', time = '', ...subject] = line.split('\0');
    const authorship = [name, email, time].join('\0');
    return { sha, authorship, identity: [authorship, ...subject].join('\0') };
  });
};

export const findUnpickedCommits = async (
  runGit: RunGit,
  { directory, base, commits }: { directory: string; base: string; commits: string[] },
) => {
  if (commits.length === 0) {
    return [];
  }
  const planned = new Map((await readCommits(runGit, directory, ['--no-walk=unsorted', ...commits])).map((entry) => [entry.sha, entry]));
  const landed = await readCommits(runGit, directory, [`${base}..HEAD`]);
  let unpicked = [...commits];
  for (const key of ['identity', 'authorship'] as const) {
    unpicked = unpicked.filter((sha) => {
      const index = landed.findIndex((entry) => entry[key] === planned.get(sha)?.[key]);
      if (index >= 0) {
        landed.splice(index, 1);
      }
      return index < 0;
    });
  }
  return unpicked;
};
