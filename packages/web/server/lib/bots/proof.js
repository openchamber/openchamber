import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { addDetachedWorktree, removeDetachedWorktree, runGitCommandNoEditor } from '../git/service.js';
import { runCommand } from '../spaces/run-command.js';
import { SpaceError } from '../spaces/errors.js';

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const inputSchema = z.object({
  directory: z.string().min(1),
  testSha: sha,
  fixSha: sha,
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(20_000)).max(1_000),
  isolated: z.boolean().default(false),
});

// Only process exit codes are proof. Signals, a missing executable and output
// limits cannot establish that the regression test failed.
const execute = async ({ directory, command, args, signal, timeoutMs }) => {
  try {
    const result = await runCommand(command, args, { cwd: directory, signal, timeoutMs, killTree: true, maxOutputBytes: 4 * 1024 * 1024 });
    return { exitCode: [126, 127].includes(result.code) ? null : result.code };
  } catch (error) {
    if (!(error instanceof SpaceError)) throw error;
    return { exitCode: null };
  }
};

/** Runs the user-configured test command on immutable, separate snapshots.
 * The item worktree is never checked out, reset or cleaned by proof. */
export const createBotProofRunner = ({ root, git = { addDetachedWorktree, removeDetachedWorktree, runGitCommandNoEditor }, executeCommand = execute, executeIsolatedProof, timeoutMs = 120_000 } = {}) => {
  if (!root) throw new TypeError('Bot proof needs an owned checkout root');
  const readGit = async (directory, args) => {
    const result = await git.runGitCommandNoEditor(directory, args);
    if (!result.success) throw new Error('Could not read the commits for bot proof');
    return result.stdout;
  };

  const run = async (raw, { signal: cancellation } = {}) => {
    const input = inputSchema.parse(raw);
    const result = { status: 'inconclusive', testSha: input.testSha, fixSha: input.fixSha,
      command: input.command, args: input.args, testExitCode: null, fixExitCode: null };
    if (input.isolated) {
      if (!executeIsolatedProof) return { ...result, reason: 'Isolated proof is unavailable. No command ran on the host.' };
      return executeIsolatedProof(input, { signal: cancellation });
    }

    const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let temporaryRoot;
    const checkouts = [];
    try {
      signal?.throwIfAborted();
      const ancestor = await git.runGitCommandNoEditor(input.directory, ['merge-base', '--is-ancestor', input.testSha, input.fixSha]);
      if (!ancestor.success || input.testSha === input.fixSha) return { ...result, reason: 'The fix must descend from a different test commit.' };
      const changed = await readGit(input.directory, ['-c', 'core.fsmonitor=false', 'diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', input.testSha, '--']);
      const files = changed.split('\0').filter(Boolean);
      if (!files.length) return { ...result, reason: 'The test commit changes no files.' };
      const args = input.args.flatMap((argument) => argument === '{files}' ? files : [argument]);
      result.args = args;
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      temporaryRoot = await fs.mkdtemp(path.join(root, 'proof-'));
      for (const [name, commit] of [['test', input.testSha], ['fix', input.fixSha]]) {
        signal?.throwIfAborted();
        const directory = path.join(temporaryRoot, name);
        await git.addDetachedWorktree(input.directory, directory, commit);
        checkouts.push(directory);
        const outcome = await executeCommand({ directory, command: input.command, args, signal, timeoutMs });
        if (name === 'test') result.testExitCode = outcome.exitCode;
        else result.fixExitCode = outcome.exitCode;
        if (outcome.exitCode === null) return { ...result, reason: 'The test process could not complete. A process failure is not a regression result.' };
      }
      if (result.testExitCode === 0) return { ...result, status: 'failed', reason: 'The test also passes without the fix.' };
      if (result.fixExitCode !== 0) return { ...result, status: 'failed', reason: 'The test still fails with the fix.' };
      return { ...result, status: 'passed' };
    } catch (error) {
      return { ...result, reason: signal?.aborted ? 'Proof was interrupted.' : error instanceof Error ? error.message : 'Proof could not complete.' };
    } finally {
      // A failed removal must remain visible. Do not erase an owned path until
      // Git has released the corresponding worktree record.
      for (const directory of checkouts.reverse()) await git.removeDetachedWorktree(input.directory, directory);
      if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  };
  return { run };
};
