/** Tools whose whole purpose is talking to a Git host. */
const PROVIDER_CLIS = new Set(['gh', 'glab', 'hub']);

/**
 * `git` subcommands that reach a remote.
 *
 * Enforcement names what it blocks, rather than clearing what it recognises as
 * local. Blocking is not a warning: a rule that errs towards "unknown, so
 * block" stops ordinary work, and everything it would catch by accident is
 * already caught by the credential answer, which gives an unbound repository
 * nothing. The UI's `shellOperationBoundary` errs the other way on purpose —
 * it labels a call that already ran, where a missed label is the worse mistake.
 */
const NETWORK_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'ls-remote', 'archive', 'request-pull', 'send-email', 'submodule',
]);

/** `git` options that take a separate value, so the value is not the subcommand. */
const OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const SEGMENT_SEPARATOR = /\|\||&&|[;|\n]/;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `submodule` reaches the network only for the subcommands that fetch. */
const NETWORK_SUBMODULE_ARGUMENTS = new Set(['update', 'add', 'sync']);

const commandTokens = (segment) => segment
  .replace(/[(){}]/g, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .filter((token, index, tokens) => index >= tokens.findIndex((entry) => !ENVIRONMENT_ASSIGNMENT.test(entry)));

const gitSubcommand = (tokens) => {
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index].includes('=') ? tokens[index].split('=')[0] : tokens[index];
    index += OPTIONS_WITH_VALUE.has(option) && !tokens[index].includes('=') ? 2 : 1;
  }
  const subcommand = tokens[index];
  return subcommand ? { subcommand: subcommand.toLowerCase(), rest: tokens.slice(index + 1) } : null;
};

const segmentTransfers = (segment) => {
  const tokens = commandTokens(segment);
  if (!tokens.length) return false;
  const tool = tokens[0].split('/').pop()?.toLowerCase() ?? '';
  if (PROVIDER_CLIS.has(tool)) return true;
  if (tool !== 'git') return false;
  const parsed = gitSubcommand(tokens);
  if (!parsed || !NETWORK_SUBCOMMANDS.has(parsed.subcommand)) return false;
  if (parsed.subcommand === 'submodule') {
    return parsed.rest.some((argument) => NETWORK_SUBMODULE_ARGUMENTS.has(argument));
  }
  return true;
};

/**
 * Whether a shell command would transfer to or from a Git host.
 *
 * A command is inspected segment by segment, because one `&&` is enough to
 * hide a push behind a status check.
 */
export const shellCommandTransfers = (command) => {
  if (Object.prototype.toString.call(command) !== '[object String]' || !command.trim()) return false;
  return command.split(SEGMENT_SEPARATOR).some(segmentTransfers);
};
