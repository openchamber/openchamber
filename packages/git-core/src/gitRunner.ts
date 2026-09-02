import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitCommandResult, GitRunner } from './types.js';

const execFileAsync = promisify(execFile);

export interface ChildProcessGitRunnerOptions {
  /** Absolute path to the `git` binary. Defaults to `'git'`. */
  binary?: string;
  /** Environment variables passed to every invocation. */
  env?: NodeJS.ProcessEnv;
  /** Hide the spawned process window (Windows). Defaults to `true`. */
  windowsHide?: boolean;
  /** Maximum stdout/stderr buffer size in bytes. Defaults to 20 MiB. */
  maxBuffer?: number;
}

/**
 * Create a {@link GitRunner} backed by `child_process.execFile`.
 *
 * Currently used by test fixtures to spin up real temp git repos. The
 * web server and VS Code extension host both wrap their own
 * pre-existing executors (`runGitCommand`) in a `gitRunner` adapter
 * instead, as those executors already handle binary resolution and
 * SSH env assembly specific to each runtime.
 */
export const createChildProcessGitRunner = (
  options: ChildProcessGitRunnerOptions = {},
): GitRunner => {
  const binary = options.binary ?? 'git';
  const env = options.env ?? process.env;
  const windowsHide = options.windowsHide ?? true;
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;

  const parseErrorMessage = (error: Error | null): string => {
    if (!error) {
      return '';
    }
    // Note: we intentionally do NOT include `error.message` because
    // `execFile` populates it with the full command line (including
    // any sensitive refspecs or URLs). Align with the VS Code
    // extension's behaviour which uses only stderr/stdout.
    const stderr = 'stderr' in error ? error.stderr : '';
    const stdout = 'stdout' in error ? error.stdout : '';
    return [stderr, stdout]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  };

  return {
    async run(cwd: string, args: string[]): Promise<GitCommandResult> {
      try {
        const { stdout, stderr } = await execFileAsync(binary, args, {
          cwd,
          env,
          windowsHide,
          maxBuffer,
        });
        return {
          success: true,
          exitCode: 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        };
      } catch (error) {
        const execError = error instanceof Error ? error : null;
        const code = execError && 'code' in execError ? execError.code : undefined;
        return {
          success: false,
          exitCode: Number.isInteger(code) ? Number(code) : 1,
          stdout: String(execError && 'stdout' in execError ? execError.stdout : ''),
          stderr: String(execError && 'stderr' in execError ? execError.stderr : ''),
          message: parseErrorMessage(execError),
        };
      }
    },
  };
};
