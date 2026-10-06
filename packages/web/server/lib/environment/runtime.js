import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { primaryWorktreeRootFromGitDir } from '../git/repository-root.js';
import { overlayEnvironment, parseEnvironmentOutput } from './variables.js';

/**
 * Which environment variables each process OpenChamber starts receives on top
 * of its own environment:
 *
 * - the managed OpenCode: the user's variables, over the variables
 *   `opencode service set env` stored. One OpenCode serves every project, so
 *   a project's variables cannot reach it. Enterprise mode passes nothing:
 *   a variable can carry a provider key, and enterprise mode refuses new
 *   provider keys from the app.
 * - Git, the terminal (and the project actions it runs), worktree setup
 *   commands and command execution for a directory: the user's variables,
 *   then what the project's environment command printed, then the project's
 *   own variables, later layers winning.
 *
 * The project is found from the directory: a configured project that
 * contains it, or, for a linked worktree, the project at the same place in
 * the repository's primary checkout. A worktree uses the project's settings
 * but runs the command in its own checkout, so direnv or devenv sees the
 * worktree's files.
 *
 * The command runs once per project checkout and its result is kept for
 * `commandTtlMs`. After that the kept result is still used while a fresh run
 * happens in the background; only the very first run is waited for. A failed
 * run applies nothing from the command and is reported through
 * `projectStatus`, never as a silent success. Command output and its error
 * text are never logged or returned: they may hold secrets.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TTL_MS = 5 * 60_000;
const DEFAULT_PROJECT_LOOKUP_TTL_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;

const setBounded = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) {
    map.delete(map.keys().next().value);
  }
};

const isInside = (directory, root) => directory === root || directory.startsWith(`${root}${path.sep}`);

const runCommand = ({ spawn, command, cwd, env, timeoutMs }) => new Promise((resolve) => {
  let stdout = '';
  let settled = false;
  let timer = null;
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(outcome);
  };

  let child;
  try {
    child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    finish({ ok: false, reason: 'spawn' });
    return;
  }

  timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    finish({ ok: false, reason: 'timeout' });
  }, timeoutMs);

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > MAX_COMMAND_OUTPUT_BYTES) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
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
}) => {
  // directory -> { at, target }
  const targetCache = new Map();
  // `${projectId}\0${root}` -> { at, variables }
  const commandCache = new Map();
  const commandRuns = new Map();
  // projectId -> last run outcome, for Settings.
  const statuses = new Map();
  // Bumped when a project's settings change: a run that started before the
  // change is reported but not kept, so the change applies on the next spawn.
  const generations = new Map();
  let projectsCache = null;
  // Git asks on every command; a broken store must not log on every poll.
  const reported = new Set();
  const warnOnce = (message) => {
    if (reported.has(message)) return;
    reported.add(message);
    logger.warn(message);
  };

  const readUserVariables = () => {
    try {
      return store.userVariables();
    } catch (error) {
      warnOnce(`[environment] user variables not applied: ${error.message}`);
      return {};
    }
  };

  const readProjectEntry = (projectId) => {
    try {
      return store.projectEntry(projectId);
    } catch (error) {
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

  const longestMatch = (candidates) => candidates.reduce(
    (best, candidate) => (!best || candidate.root.length > best.root.length ? candidate : best),
    null,
  );

  const findCheckoutRoot = async (directory) => {
    for (let current = directory; ; current = path.dirname(current)) {
      const entry = await stat(path.join(current, '.git')).catch(() => null);
      if (entry) return { root: current, isLinkedWorktree: entry.isFile() };
      if (path.dirname(current) === current) return null;
    }
  };

  // A linked worktree's `.git` file names its git dir inside the primary
  // checkout's `.git/worktrees/`. Read directly, not through Git: Git itself
  // asks this runtime for its environment.
  const primaryRootOf = async (checkoutRoot) => {
    const content = await readFile(path.join(checkoutRoot, '.git'), 'utf8').catch(() => '');
    const gitDir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
    if (!gitDir) return null;
    const absolute = path.resolve(checkoutRoot, gitDir).replace(/\\/g, '/');
    const primary = primaryWorktreeRootFromGitDir(absolute);
    return primary ? path.resolve(primary) : null;
  };

  const findTarget = async (directory) => {
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

  const targetFor = async (directory) => {
    const cached = targetCache.get(directory);
    if (cached && now() - cached.at < projectLookupTtlMs) return cached.target;
    const target = await findTarget(directory);
    setBounded(targetCache, directory, { at: now(), target });
    return target;
  };

  const generationOf = (projectId) => generations.get(projectId) ?? 0;

  const runProjectCommand = (projectId, root, command) => {
    const key = `${projectId}\0${root}`;
    const pending = commandRuns.get(key);
    if (pending) return pending;

    const generation = generationOf(projectId);
    const run = (async () => {
      const env = overlayEnvironment(commandBaseEnv(), readUserVariables());
      const outcome = await runCommand({ spawn, command, cwd: root, env, timeoutMs: commandTimeoutMs });
      const variables = outcome.ok ? parseEnvironmentOutput(outcome.stdout, env) : null;
      const status = outcome.ok
        ? (variables
          ? { state: 'applied', count: Object.keys(variables).length, at: now() }
          : { state: 'failed', reason: 'unrecognized-output', at: now() })
        : { state: 'failed', reason: outcome.reason, ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}), at: now() };
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

  const commandVariables = async (projectId, root, command) => {
    const cached = commandCache.get(`${projectId}\0${root}`);
    if (!cached) return runProjectCommand(projectId, root, command);
    if (now() - cached.at >= commandTtlMs) void runProjectCommand(projectId, root, command);
    return cached.variables;
  };

  /**
   * The variables to lay over the environment of a process started in
   * `directory`, or null when there are none. Never throws: a spawn always
   * goes ahead, with what could be resolved.
   */
  const forDirectory = async (directory) => {
    const userVariables = readUserVariables();
    let projectVariables = {};
    try {
      // Most users configure nothing; Git polling must not pay for a lookup then.
      const target = store.hasProjectEntries() ? await targetFor(path.resolve(directory)) : null;
      if (target) {
        const entry = readProjectEntry(target.projectId);
        const fromCommand = entry.command ? await commandVariables(target.projectId, target.root, entry.command) : {};
        projectVariables = { ...fromCommand, ...entry.variables };
      }
    } catch (error) {
      // The user's variables still apply when the project part cannot be resolved.
      warnOnce(`[environment] project variables not applied: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const variables = { ...userVariables, ...projectVariables };
    return Object.keys(variables).length > 0 ? variables : null;
  };

  /** The variables for the managed OpenCode process; none in enterprise mode. */
  const forOpenCode = () => {
    if (isEnterpriseMode()) return {};
    let serviceVariables = {};
    try {
      serviceVariables = readOpenCodeServiceEnv();
    } catch {
      serviceVariables = {};
    }
    return { ...serviceVariables, ...readUserVariables() };
  };

  /** The last outcome of the project's environment command, or null before any run. */
  const projectStatus = (projectId) => statuses.get(projectId) ?? null;

  /** Forget everything kept for a project; its settings changed. */
  const invalidateProject = (projectId) => {
    generations.set(projectId, generationOf(projectId) + 1);
    statuses.delete(projectId);
    for (const key of commandCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) commandCache.delete(key);
    }
  };

  /**
   * Run the project's environment command now in the project's own checkout
   * and answer its outcome. Null when the project has no command.
   */
  const reloadProject = async (projectId, projectPath) => {
    invalidateProject(projectId);
    const entry = store.projectEntry(projectId);
    if (!entry.command) return null;
    await runProjectCommand(projectId, path.resolve(projectPath), entry.command);
    return projectStatus(projectId);
  };

  /** `env` with the variables for `directory` laid over it. */
  const applyToDirectory = async (directory, env) => {
    const variables = await forDirectory(directory);
    return variables ? overlayEnvironment(env, variables) : env;
  };

  return { forDirectory, applyToDirectory, forOpenCode, projectStatus, invalidateProject, reloadProject };
};
