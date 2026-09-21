// How the Docker place talks to the docker CLI: run, inspect, find by label, remove.
// Shared by the space operations in docker.js and the tools volume in docker-tools.js.

import { SpaceError } from '../errors.js';

const QUERY_TIMEOUT_MS = 30_000;
export const CHANGE_TIMEOUT_MS = 120_000;
// After a timed-out step the daemon may still finish it. A rollback sweeps again after this pause.
export const ROLLBACK_SETTLE_MS = 2_000;

// The CLI died in the middle of a step, so nobody knows whether the daemon finished it.
const INTERRUPTED_CODES = ['command_timeout', 'command_killed', 'command_output_too_large'];
export const isInterrupted = (error) => INTERRUPTED_CODES.includes(error?.code);

const NOT_FOUND_PATTERNS = [
  /\bNo such (?:object|container|volume|network|image)\b/i,
  /\b(?:container|volume|network)\b.*\bnot found\b/i,
];

const isNotFound = (result) => result.code !== 0 && NOT_FOUND_PATTERNS.some((pattern) => pattern.test(result.stderr));

// For a removal, "someone else is removing it right now" is as good as gone.
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

export function createDockerEngine({ runCommand, dockerPath }) {
  const run = (args, timeoutMs, options = {}) => runCommand(dockerPath, args, { ...options, timeoutMs });

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

  /** The parsed inspect entry, or null when Docker has no such resource. */
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

  /** The inspect entries of every resource of one kind that the label filters select. */
  const findByLabel = async (kind, filters) => {
    const names = (await docker(listArgs(kind, filters), QUERY_TIMEOUT_MS)).split('\n').filter(Boolean);
    if (names.length === 0) {
      return [];
    }
    // A name can vanish between the listing and the inspect. Docker then exits 1 but
    // still prints the entries it found, and the rest must not suffer.
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

  /** Null when the resource is gone afterwards, otherwise what went wrong. A container goes even while it runs. */
  const removeOne = (kind, name) => removeWith(removeArgs(kind, name), kind, name);

  /** The same for a container that must be stopped. Docker refuses a running one, and that refusal is the point. */
  const removeStoppedContainer = (nameOrId) => removeWith(['rm', nameOrId], 'container', nameOrId);

  /**
   * Removes the named resources that exist, labelled or not. Only for names that the
   * same call found absent a moment ago: a `docker create` or `docker run` that
   * the daemon finishes late makes a missing `src=` volume again, without labels.
   */
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

  return { run, docker, failure, inspect, findByLabel, removeOne, removeStoppedContainer, removeByName };
}
