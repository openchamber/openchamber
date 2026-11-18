import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { spawn as spawnProcess } from 'node:child_process';

import { primaryWorktreeRootFromGitDir } from '../git/repository-root.js';
import { isUserAction } from './refresh-scope.js';
import { overlayEnvironment, parseEnvironmentOutput } from './variables.js';
import type { EnvironmentVariables, ProcessEnvironment } from './variables.js';
import type { EnvironmentStore } from './store.js';

export type ProjectEnvironmentStatus = { state: 'applied'; count: number; at: number }
  | { state: 'failed'; reason: 'spawn' | 'timeout' | 'output-too-large' | 'exit' | 'unrecognized-output'; exitCode?: number | null; at: number };

type Project = { id: string; path: string };
type Target = { projectId: string; root: string };
type DirectoryOptions = { refresh?: boolean };
type CommandOutcome = { ok: true; stdout: string }
  | { ok: false; reason: 'spawn' | 'timeout' | 'output-too-large' | 'exit'; exitCode?: number | null };
interface EnvironmentRuntimeOptions {
  store: EnvironmentStore;
  listProjects: () => Promise<Project[]>;
  spawn: typeof spawnProcess;
  commandBaseEnv: () => ProcessEnvironment;
  readOpenCodeServiceEnv?: () => EnvironmentVariables;
  isEnterpriseMode: () => boolean;
  readFile?: typeof fsPromises.readFile;
  stat?: typeof fsPromises.stat;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
  commandTimeoutMs?: number;
  commandTtlMs?: number;
  projectLookupTtlMs?: number;
}

export type EnvironmentRuntime = ReturnType<typeof createEnvironmentRuntime>;

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TTL_MS = 5 * 60_000;
const DEFAULT_PROJECT_LOOKUP_TTL_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;

const hasReadableMessage = (value: unknown): value is { message?: unknown } => value !== null && value !== undefined;

const setBounded = <Value>(map: Map<string, Value>, key: string, value: Value) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) {
    for (const oldestKey of map.keys()) {
      map.delete(oldestKey);
      break;
    }
  }
};

const isInside = (directory: string, root: string) => directory === root || directory.startsWith(`${root}${path.sep}`);

const runCommand = ({ spawn, command, cwd, env, timeoutMs }: {
  spawn: typeof spawnProcess;
  command: string;
  cwd: string;
  env: ProcessEnvironment;
  timeoutMs: number;
}) => new Promise<CommandOutcome>((resolve) => {
  let stdout = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (outcome: CommandOutcome) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    resolve(outcome);
  };

  let child: ReturnType<typeof spawnProcess>;
  try {
    child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    finish({ ok: false, reason: 'spawn' });
    return;
  }

  timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { void 0; }
    finish({ ok: false, reason: 'timeout' });
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_COMMAND_OUTPUT_BYTES) {
      try { child.kill('SIGKILL'); } catch { void 0; }
      finish({ ok: false, reason: 'output-too-large' });
    }
  });
  child.on('error', () => finish({ ok: false, reason: 'spawn' }));
  child.on('close', (code) => finish(code === 0 ? { ok: true, stdout } : { ok: false, reason: 'exit', exitCode: code }));
});

export const createEnvironmentRuntime = ({
  store,
  listProjects,
  spawn,
  commandBaseEnv,
  readOpenCodeServiceEnv = () => ({}),
  isEnterpriseMode,
  readFile = fsPromises.readFile,
  stat = fsPromises.stat,
  now = Date.now,
  logger = console,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  commandTtlMs = DEFAULT_COMMAND_TTL_MS,
  projectLookupTtlMs = DEFAULT_PROJECT_LOOKUP_TTL_MS,
}: EnvironmentRuntimeOptions) => {
  const targetCache = new Map<string, { at: number; target: Target | null }>();
  const commandCache = new Map<string, { at: number; variables: EnvironmentVariables }>();
  const commandRuns = new Map<string, Promise<EnvironmentVariables>>();
  const statuses = new Map<string, ProjectEnvironmentStatus>();
  const generations = new Map<string, number>();
  let projectsCache: { at: number; list: Project[] } | null = null;
  const reported = new Set<string>();
  const warnOnce = (message: string) => {
    if (reported.has(message)) return;
    reported.add(message);
    logger.warn(message);
  };

  const readUserVariables = () => {
    try {
      return store.userVariables();
    } catch (error) {
      if (!hasReadableMessage(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
      warnOnce(`[environment] user variables not applied: ${error.message}`);
      return {};
    }
  };

  const readProjectEntry = (projectId: string) => {
    try {
      return store.projectEntry(projectId);
    } catch (error) {
      if (!hasReadableMessage(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
      warnOnce(`[environment] project variables not applied: ${error.message}`);
      return { variables: {}, command: null };
    }
  };

  const projects = async () => {
    if (projectsCache && now() - projectsCache.at < projectLookupTtlMs) return projectsCache.list;
    const list = (await listProjects()).map((project) => ({ id: project.id, path: path.resolve(project.path) }));
    projectsCache = { at: now(), list };
    return list;
  };

  const longestMatch = (candidates: Target[]) => candidates.reduce<Target | null>(
    (best, candidate) => (!best || candidate.root.length > best.root.length ? candidate : best),
    null,
  );

  const findCheckoutRoot = async (directory: string) => {
    for (let current = directory; ; current = path.dirname(current)) {
      const entry = await stat(path.join(current, '.git')).catch(() => null);
      if (entry) return { root: current, isLinkedWorktree: entry.isFile() };
      if (path.dirname(current) === current) return null;
    }
  };

  const primaryRootOf = async (checkoutRoot: string) => {
    const content = await readFile(path.join(checkoutRoot, '.git'), 'utf8').catch(() => '');
    const gitDir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
    if (!gitDir) return null;
    const absolute = path.resolve(checkoutRoot, gitDir).replace(/\\/g, '/');
    const primary = primaryWorktreeRootFromGitDir(absolute);
    return primary ? path.resolve(primary) : null;
  };

  const findTarget = async (directory: string) => {
    const list = await projects();
    const direct = longestMatch(list
      .filter((project) => isInside(directory, project.path))
      .map((project) => ({ projectId: project.id, root: project.path })));
    if (direct) return direct;

    const checkout = await findCheckoutRoot(directory);
    if (!checkout?.isLinkedWorktree) return null;
    const primaryRoot = await primaryRootOf(checkout.root);
    if (!primaryRoot) return null;
    return longestMatch(list
      .filter((project) => isInside(project.path, primaryRoot))
      .map((project) => ({ projectId: project.id, root: path.join(checkout.root, path.relative(primaryRoot, project.path)) }))
      .filter((candidate) => isInside(directory, candidate.root)));
  };

  const targetFor = async (directory: string) => {
    const cached = targetCache.get(directory);
    if (cached && now() - cached.at < projectLookupTtlMs) return cached.target;
    const target = await findTarget(directory);
    setBounded(targetCache, directory, { at: now(), target });
    return target;
  };

  const generationOf = (projectId: string) => generations.get(projectId) ?? 0;

  const runProjectCommand = (projectId: string, root: string, command: string) => {
    const key = `${projectId}\0${root}`;
    const pending = commandRuns.get(key);
    if (pending) return pending;

    const generation = generationOf(projectId);
    const run = (async () => {
      const env = overlayEnvironment(commandBaseEnv(), readUserVariables());
      const outcome = await runCommand({ spawn, command, cwd: root, env, timeoutMs: commandTimeoutMs });
      const variables = outcome.ok ? parseEnvironmentOutput(outcome.stdout, env) : null;
      const status: ProjectEnvironmentStatus = outcome.ok
        ? (variables
          ? { state: 'applied', count: Object.keys(variables).length, at: now() }
          : { state: 'failed', reason: 'unrecognized-output', at: now() })
        : { state: 'failed', reason: outcome.reason, at: now() };
      if (!outcome.ok && outcome.exitCode !== undefined && status.state === 'failed') status.exitCode = outcome.exitCode;
      if (status.state === 'failed') {
        logger.warn(`[environment] environment command for project ${projectId} failed: ${status.reason}${status.exitCode !== undefined ? ` (exit ${status.exitCode})` : ''}`);
      }
      if (generationOf(projectId) === generation) {
        statuses.set(projectId, status);
        setBounded(commandCache, key, { at: now(), variables: variables ?? {} });
      }
      return variables ?? {};
    })().finally(() => {
      if (commandRuns.get(key) === run) commandRuns.delete(key);
    });
    commandRuns.set(key, run);
    return run;
  };

  const commandVariables = async (projectId: string, root: string, command: string, refresh: boolean) => {
    const cached = commandCache.get(`${projectId}\0${root}`);
    if (!refresh) return cached?.variables ?? {};
    if (!cached) return runProjectCommand(projectId, root, command);
    if (now() - cached.at >= commandTtlMs) void runProjectCommand(projectId, root, command);
    return cached.variables;
  };

  const forDirectory = async (directory: string, { refresh = isUserAction() }: DirectoryOptions = {}) => {
    const userVariables = readUserVariables();
    let projectVariables: EnvironmentVariables = {};
    try {
      const target = store.hasProjectEntries() ? await targetFor(path.resolve(directory)) : null;
      if (target) {
        const entry = readProjectEntry(target.projectId);
        const fromCommand = entry.command ? await commandVariables(target.projectId, target.root, entry.command, refresh) : {};
        projectVariables = { ...fromCommand, ...entry.variables };
      }
    } catch (error) {
      warnOnce(`[environment] project variables not applied: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const variables = { ...userVariables, ...projectVariables };
    return Object.keys(variables).length > 0 ? variables : null;
  };

  const forOpenCode = () => {
    if (isEnterpriseMode()) return {};
    let serviceVariables: EnvironmentVariables = {};
    try {
      serviceVariables = readOpenCodeServiceEnv();
    } catch {
      serviceVariables = {};
    }
    return { ...serviceVariables, ...readUserVariables() };
  };

  const projectStatus = (projectId: string) => statuses.get(projectId) ?? null;

  const invalidateProject = (projectId: string) => {
    generations.set(projectId, generationOf(projectId) + 1);
    statuses.delete(projectId);
    for (const key of commandCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) commandCache.delete(key);
    }
  };

  const reloadProject = async (projectId: string, projectPath: string) => {
    invalidateProject(projectId);
    const entry = store.projectEntry(projectId);
    if (!entry.command) return null;
    await runProjectCommand(projectId, path.resolve(projectPath), entry.command);
    return projectStatus(projectId);
  };

  const applyToDirectory = async (directory: string, env: ProcessEnvironment, options?: DirectoryOptions) => {
    const variables = await forDirectory(directory, options);
    return variables ? overlayEnvironment(env, variables) : env;
  };

  return { forDirectory, applyToDirectory, forOpenCode, projectStatus, invalidateProject, reloadProject };
};
