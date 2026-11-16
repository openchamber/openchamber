
import { SpaceError } from '../errors.js';

const QUERY_TIMEOUT_MS = 30_000;
export const CHANGE_TIMEOUT_MS = 120_000;
export const ROLLBACK_SETTLE_MS = 2_000;

const INTERRUPTED_CODES = ['command_timeout', 'command_killed', 'command_output_too_large'];
export const isInterrupted = (error) => INTERRUPTED_CODES.includes(error?.code);

const NOT_FOUND_PATTERNS = [
  /\bNo such (?:object|container|volume|network|image)\b/i,
  /\b(?:container|volume|network)\b.*\bnot found\b/i,
];

const isNotFound = (result) => result.code !== 0 && NOT_FOUND_PATTERNS.some((pattern) => pattern.test(result.stderr));

const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;
const isAlreadyGone = (result) => isNotFound(result) || (result.code !== 0 && REMOVAL_IN_PROGRESS.test(result.stderr));

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new SpaceError('docker_output_unreadable', 'Docker printed something that is not JSON');
  }
};

const inspectArgs = (kind, names) => (kind === 'container' ? ['inspect', '--type', 'container', ...names] : [kind, 'inspect', ...names]);
const listArgs = (kind, filters) => (kind === 'container'
  ? ['ps', '--all', ...filters, '--format', '{{.Names}}']
  : [kind, 'ls', ...filters, '--format', '{{.Name}}']);
const removeArgs = (kind, name) => (kind === 'container' ? ['rm', '--force', name] : [kind, 'rm', name]);

export const entryLabels = (kind, entry) => (kind === 'container' ? entry.Config?.Labels : entry.Labels);
export const entryName = (entry) => String(entry.Name ?? '').replace(/^\//, '');

export const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

export function createDockerEngine({ runCommand, dockerPath, dockerHost = null }) {
  const argsFor = (args) => (dockerHost === null ? args : ['--host', dockerHost, ...args]);
  const run = (args, timeoutMs, options = {}) => runCommand(dockerPath, argsFor(args), { ...options, timeoutMs });

  const failure = (args, result) => new SpaceError(
    'docker_command_failed',
    `docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
  );

  const docker = async (args, timeoutMs) => {
    const result = await run(args, timeoutMs);
    if (result.code !== 0) {
      throw failure(args, result);
    }
    return result.stdout;
  };

  const inspect = async (kind, name) => {
    const args = inspectArgs(kind, [name]);
    const result = await run(args, QUERY_TIMEOUT_MS);
    if (isNotFound(result)) {
      return null;
    }
    if (result.code !== 0) {
      throw failure(args, result);
    }
    return parseJson(result.stdout)[0];
  };

  const findByLabel = async (kind, filters) => {
    const names = (await docker(listArgs(kind, filters), QUERY_TIMEOUT_MS)).split('\n').filter(Boolean);
    if (names.length === 0) {
      return [];
    }
    const args = inspectArgs(kind, names);
    const result = await run(args, QUERY_TIMEOUT_MS);
    if (result.code !== 0 && !isNotFound(result)) {
      throw failure(args, result);
    }
    return parseJson(result.stdout);
  };

  const removeWith = async (args, kind, name) => {
    try {
      const result = await run(args, CHANGE_TIMEOUT_MS);
      return result.code === 0 || isAlreadyGone(result) ? null : { kind, name, message: result.stderr.trim() };
    } catch (error) {
      return { kind, name, message: error.message };
    }
  };

  const removeOne = (kind, name) => removeWith(removeArgs(kind, name), kind, name);

  const removeStoppedContainer = (nameOrId) => removeWith(['rm', nameOrId], 'container', nameOrId);

  const removeByName = async (names) => {
    const failed = [];
    for (const [kind, name] of names) {
      try {
        if (await inspect(kind, name)) {
          const problem = await removeOne(kind, name);
          if (problem) failed.push(problem);
        }
      } catch (error) {
        failed.push({ kind, name, message: error.message });
      }
    }
    return failed;
  };

  return { run, docker, failure, inspect, findByLabel, removeOne, removeStoppedContainer, removeByName, argsFor };
}
