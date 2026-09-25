// How the host runs git against the user's repository. Every host git call of the module goes
// through here, so the environment rule lives in one place.
//
// The user's normal config applies, on purpose: their global ignore file must keep its files out
// of a space. What must not apply is anything inherited that points git at another repository,
// index or object store, so those variables never reach our git.

import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';

const QUERY_TIMEOUT_MS = 2 * 60_000;
const QUERY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Inherited from a parent process, each of these would make our commands read or write another
// repository, index, object store or ref namespace than the one we name with `-C`, or would add
// config the user did not write. `GIT_CONFIG_PARAMETERS` is how a parent git passes its `-c`
// options on. `GIT_ALLOW_PROTOCOL` would override the one protocol switch the transfer sets.
// The `GIT_TRACE` family writes to stderr, which a push counts against its output cap: an inherited
// `GIT_TRACE_PACKET` would turn every push into a failure.
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
  // These change how every pathspec is read. With GIT_LITERAL_PATHSPECS, `:(exclude,literal)<dir>`
  // would be a path, `add` would fail, and `:(attr:filter=lfs)` would match nothing.
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);
const REMOVED_PATTERN = /^(?:GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_TRACE.*)$/;

/**
 * The environment of every host git call: the given one without the variables above, plus
 * `GIT_OPTIONAL_LOCKS=0`, so a status read never rewrites the index, and `GIT_TERMINAL_PROMPT=0`,
 * so nothing waits for a password. Variable names are compared without case on Windows, where
 * the system treats `git_dir` as `GIT_DIR`.
 */
export function hostGitEnvironment(environment, platform = process.platform) {
  const normalize = platform === 'win32' ? (name) => name.toUpperCase() : (name) => name;
  const kept = Object.entries(environment).filter(([name]) => {
    const key = normalize(name);
    return !REMOVED_VARIABLES.has(key) && !REMOVED_PATTERN.test(key);
  });
  return { ...Object.fromEntries(kept), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * `{ major, minor, patch }` from the output of `git version`, or null. Builds add their own suffix,
 * such as `2.50.1 (Apple Git-155)` or `2.54.0.windows.1`, and only the first three numbers count.
 */
export function parseGitVersion(text) {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

/** Whether `version` is `floor` or newer. Both are `{ major, minor, patch }`. */
export const isGitVersionAtLeast = (version, floor) => (
  version.major !== floor.major ? version.major > floor.major
    : version.minor !== floor.minor ? version.minor > floor.minor
      : version.patch >= floor.patch
);

// The git subcommand in an argv, for messages: the first argument that is not an option or the value of `-c`.
const subcommandOf = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c') {
      index += 1;
    } else if (!args[index].startsWith('-')) {
      return args[index];
    }
  }
  return '';
};

/**
 * `run(directory, args, options)` resolves `{ code, stdout, stderr }` for any exit code, and
 * `output(directory, args, options)` resolves stdout and rejects with `git_command_failed` for a
 * non-zero one. Both run `git -C <directory> ...` through `runCommand`, with an argv and no shell.
 * `options.env` adds variables for one call, such as `GIT_INDEX_FILE`. `options.killTree` goes to
 * `runCommand` unchanged.
 *
 * `gitPath` is the git program, `environment` the environment to start from.
 */
export function createHostGit({ runCommand, gitPath = 'git', environment = process.env }) {
  const baseEnvironment = hostGitEnvironment(environment);

  const run = (directory, args, { env = {}, stdin, timeoutMs = QUERY_TIMEOUT_MS, maxOutputBytes = QUERY_MAX_OUTPUT_BYTES, killTree = false } = {}) => runCommand(
    gitPath,
    ['-C', directory, ...args],
    { env: { ...baseEnvironment, ...env }, stdin, timeoutMs, maxOutputBytes, killTree },
  );

  const output = async (directory, args, options) => {
    const result = await run(directory, args, options);
    if (result.code !== 0) {
      throw new SpaceError('git_command_failed', `git ${subcommandOf(args)} failed: ${tail(result.stderr) || `exit code ${result.code}`}`, { exitCode: result.code });
    }
    return result.stdout;
  };

  return { run, output };
}
