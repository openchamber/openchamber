
import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import type { CommandOptions, RunCommand } from './command-contracts.js';

const QUERY_TIMEOUT_MS = 2 * 60_000;
const QUERY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const REMOVED_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_QUARANTINE_PATH',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_DEFAULT_HASH',
  'GIT_DEFAULT_REF_FORMAT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_ALLOW_PROTOCOL',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_ATTR_SOURCE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);
const REMOVED_PATTERN = /^(?:GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_TRACE.*)$/;

export function hostGitEnvironment(environment: NodeJS.ProcessEnv, platform = process.platform) {
  const normalize = platform === 'win32' ? (name: string) => name.toUpperCase() : (name: string) => name;
  const kept = Object.entries(environment).filter(([name]) => {
    const key = normalize(name);
    return !REMOVED_VARIABLES.has(key) && !REMOVED_PATTERN.test(key);
  });
  return { ...Object.fromEntries(kept), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

export function parseGitVersion(text: string | null | undefined) {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

export const isGitVersionAtLeast = (version: GitVersion, floor: GitVersion) => (
  version.major !== floor.major ? version.major > floor.major
    : version.minor !== floor.minor ? version.minor > floor.minor
      : version.patch >= floor.patch
);

const subcommandOf = (args: string[]) => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument === '-c') {
      index += 1;
    } else if (!argument.startsWith('-')) {
      return argument;
    }
  }
  return '';
};

export function createHostGit({ runCommand, gitPath = 'git', environment = process.env }: { runCommand: RunCommand; gitPath?: string; environment?: NodeJS.ProcessEnv }) {
  const baseEnvironment = hostGitEnvironment(environment);

  const run = (directory: string, args: string[], { env = {}, stdin, timeoutMs = QUERY_TIMEOUT_MS, maxOutputBytes = QUERY_MAX_OUTPUT_BYTES, keepTail = false, killTree = false, keepAtExit = false, signal }: CommandOptions = {}) => runCommand(
    gitPath,
    ['-C', directory, ...args],
    { env: { ...baseEnvironment, ...env }, stdin, timeoutMs, maxOutputBytes, keepTail, killTree, keepAtExit, signal },
  );

  const output = async (directory: string, args: string[], options?: CommandOptions) => {
    const result = await run(directory, args, options);
    if (result.code !== 0) {
      throw new SpaceError('git_command_failed', `git ${subcommandOf(args)} failed: ${tail(result.stderr) || `exit code ${result.code}`}`, { exitCode: result.code });
    }
    return result.stdout;
  };

  return { run, output };
}
