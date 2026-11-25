
import { SpaceError } from '../errors.js';
import type { CommandOptions, CommandResult, RunCommand } from '../command-contracts.js';
import { parseInspectOutput } from './docker-wire.js';
import type { DockerLabelledEntry, DockerResourceKind } from './docker-wire.js';
import type { SshConnections } from './ssh-connections.js';

export interface DockerEngineOptions {
  runCommand: RunCommand;
  dockerPath: string;
  dockerHost?: string | null;
  connections?: SshConnections | null;
}

export interface DockerRemovalFailure {
  kind: string;
  name: string;
  message: unknown;
}

interface DockerEntryFields {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  errno?: unknown;
}

const canReadEntry = (value: unknown): value is DockerEntryFields => value !== null && value !== undefined;

const entryFields = <Value>(value: Value, key: keyof DockerEntryFields): DockerEntryFields => {
  if (!canReadEntry(value)) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  return value;
};

const readableEntry = <Entry>(value: Entry, key: string) => {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  return value;
};

export const failureField = <Cause>(error: Cause, key: keyof DockerEntryFields) => entryFields(error, key)[key];

const QUERY_TIMEOUT_MS = 30_000;
export const CHANGE_TIMEOUT_MS = 120_000;
export const ROLLBACK_SETTLE_MS = 2_000;

const INTERRUPTED_CODES = ['command_timeout', 'command_killed', 'command_output_too_large'];
export const isInterrupted = <Cause>(error: Cause) => {
  const code = error == null ? undefined : entryFields(error, 'code').code;
  return INTERRUPTED_CODES.some((candidate) => candidate === code);
};

const NOT_FOUND_PATTERNS = [
  /\bNo such (?:object|container|volume|network|image)\b/i,
  /\b(?:container|volume|network)\b.*\bnot found\b/i,
];

const isNotFound = (result: CommandResult) => result.code !== 0 && NOT_FOUND_PATTERNS.some((pattern) => pattern.test(result.stderr));

const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;
const isAlreadyGone = (result: CommandResult) => isNotFound(result) || (result.code !== 0 && REMOVAL_IN_PROGRESS.test(result.stderr));

const inspectArgs = (kind: string, names: string[]) => (kind === 'container' ? ['inspect', '--type', 'container', ...names] : [kind, 'inspect', ...names]);
const listArgs = (kind: string, filters: string[]) => (kind === 'container'
  ? ['ps', '--all', ...filters, '--format', '{{.Names}}']
  : [kind, 'ls', ...filters, '--format', '{{.Name}}']);
const removeArgs = (kind: string, name: string) => (kind === 'container' ? ['rm', '--force', name] : [kind, 'rm', name]);

export const entryLabels = (kind: string, entry: DockerLabelledEntry) => (kind === 'container' ? readableEntry(entry, 'Config').Config?.Labels : readableEntry(entry, 'Labels').Labels);
export const entryName = (entry: DockerLabelledEntry) => String(readableEntry(entry, 'Name').Name ?? '').replace(/^\//, '');

export const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

export function createDockerEngine({ runCommand, dockerPath, dockerHost = null, connections = null }: DockerEngineOptions) {
  const argsFor = (args: string[]) => (dockerHost === null ? args : ['--host', dockerHost, ...args]);
  const run = async (args: string[], timeoutMs: number, options: CommandOptions = {}, spaceId: string | null = null) => {
    if (connections === null) return runCommand(dockerPath, argsFor(args), { ...options, timeoutMs });
    const lease = await connections.lease(spaceId);
    let killed = true;
    try {
      const environment = lease.path === null ? {} : { env: { ...(options.env ?? process.env), PATH: lease.path } };
      const result = await runCommand(dockerPath, argsFor(args), { ...options, ...environment, timeoutMs });
      killed = false;
      return result;
    } finally {
      lease.release({ killed });
    }
  };

  const failure = (args: string[], result: CommandResult) => new SpaceError(
    'docker_command_failed',
    `docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
  );

  const docker = async (args: string[], timeoutMs: number) => {
    const result = await run(args, timeoutMs);
    if (result.code !== 0) {
      throw failure(args, result);
    }
    return result.stdout;
  };

  const inspect = async <Kind extends DockerResourceKind>(kind: Kind, name: string) => {
    const args = inspectArgs(kind, [name]);
    const result = await run(args, QUERY_TIMEOUT_MS);
    if (isNotFound(result)) {
      return null;
    }
    if (result.code !== 0) {
      throw failure(args, result);
    }
    return readableEntry(parseInspectOutput<Kind>(result.stdout), '0')[0];
  };

  const findByLabel = async <Kind extends DockerResourceKind>(kind: Kind, filters: string[]) => {
    const names = (await docker(listArgs(kind, filters), QUERY_TIMEOUT_MS)).split('\n').filter(Boolean);
    if (names.length === 0) {
      return [];
    }
    const args = inspectArgs(kind, names);
    const result = await run(args, QUERY_TIMEOUT_MS);
    if (result.code !== 0 && !isNotFound(result)) {
      throw failure(args, result);
    }
    return parseInspectOutput<Kind>(result.stdout);
  };

  const removeWith = async (args: string[], kind: string, name: string): Promise<DockerRemovalFailure | null> => {
    try {
      const result = await run(args, CHANGE_TIMEOUT_MS);
      return result.code === 0 || isAlreadyGone(result) ? null : { kind, name, message: result.stderr.trim() };
    } catch (error) {
      return { kind, name, message: entryFields(error, 'message').message };
    }
  };

  const removeOne = (kind: string, name: string) => removeWith(removeArgs(kind, name), kind, name);

  const removeStoppedContainer = (nameOrId: string) => removeWith(['rm', nameOrId], 'container', nameOrId);

  const removeByName = async (names: [DockerResourceKind, string][]) => {
    const failed: DockerRemovalFailure[] = [];
    for (const [kind, name] of names) {
      try {
        if (await inspect(kind, name)) {
          const problem = await removeOne(kind, name);
          if (problem) failed.push(problem);
        }
      } catch (error) {
        failed.push({ kind, name, message: entryFields(error, 'message').message });
      }
    }
    return failed;
  };

  return { run, docker, failure, inspect, findByLabel, removeOne, removeStoppedContainer, removeByName, argsFor };
}

export type DockerEngine = ReturnType<typeof createDockerEngine>;
