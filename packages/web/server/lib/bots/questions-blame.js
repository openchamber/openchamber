import { z } from 'zod';
import { botGit } from './production-git.js';
import { BotServiceError, providerResult, revision, sha, text } from './services/contracts.js';

const commitSchema = z.object({ sha, author: z.object({ login: text, id: revision, type: z.enum(['User', 'Bot']) }).nullable(),
  commit: z.object({ committer: z.object({ date: z.iso.datetime() }) }) });

/** Read only. Git supplies commit IDs; GitHub supplies their account attribution. */
export function createBotQuestionBlame({ context }) {
  if (!(context?.github instanceof Function)) throw new TypeError('Question blame requires the GitHub credential owner');
  return async ({ project, bot, item, snapshot }) => {
    sha.parse(snapshot.baseSha);
    sha.parse(snapshot.headSha);
    // Blame the pre-change files, including deleted and renamed paths. New files
    // have no previous author; blaming the bot's new lines would select the bot.
    const files = [...new Set(snapshot.changes.flatMap((change) => change.oldPath ? [change.oldPath] : []))].sort();
    if (!files.length) return [];
    if (files.length > 20) throw new BotServiceError('BOT_QUESTION_BLAME_LIMIT', 'Question attribution exceeds 20 changed files.');
    const ancestor = sha.parse((await botGit(item.worktree, ['merge-base', snapshot.baseSha, snapshot.headSha])).trim());
    const commits = new Map();
    for (const file of files) {
      const output = await botGit(item.worktree, ['--literal-pathspecs', 'blame', '--line-porcelain', '--no-textconv', ancestor, '--', file]);
      for (const match of output.matchAll(/^([a-f0-9]{40}) [0-9]+ [0-9]+(?: [0-9]+)?$/gm)) {
        const paths = commits.get(match[1]) ?? new Set();
        paths.add(file); commits.set(match[1], paths);
      }
      if (commits.size > 100) throw new BotServiceError('BOT_QUESTION_BLAME_LIMIT', 'Question attribution exceeds 100 commits.');
    }
    if (!commits.size) return [];
    const { binding, credential } = await context.github({ project, bot });
    const authors = [];
    for (const [commit, paths] of commits) {
      const result = providerResult(commitSchema, await credential.request({
        path: `/repos/${binding.target.owner}/${binding.target.repo}/commits/${commit}`,
      }));
      if (result.sha !== commit) throw new BotServiceError('BOT_QUESTION_COMMIT_MISMATCH', 'GitHub returned another commit.');
      if (result.author?.type === 'User') authors.push({ sha: commit, github: result.author.login,
        githubId: result.author.id, committedAt: result.commit.committer.date, files: [...paths] });
    }
    return authors.sort((left, right) => right.committedAt.localeCompare(left.committedAt) || left.sha.localeCompare(right.sha));
  };
}
