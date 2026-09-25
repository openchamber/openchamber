// Per-project shell environment (direnv-style).
//
// A project can opt in to having a command describe its development shell
// environment (`devenv print-dev-env --json`, `direnv export json`, a plain
// `export NAME=value` script). OpenChamber runs that command once, parses its
// output, and overlays the result onto the environment of every process it
// spawns for the project: Git, the terminal (and therefore Project Actions),
// and fs exec.
//
// Trust model: the command comes only from the user's own per-project file
// (`~/.config/openchamber/projects/<projectId>.json`), never from the shared
// `.openchamber/project.json` a teammate could commit, and nothing runs until
// the user explicitly enables it. A repo can already ask for setup commands
// and actions, but those are explicit, one-shot, and gated behind a trust
// prompt; an environment command runs on *every* spawn for the project, so it
// stays a local decision by design.

const SHELL_ENV_COMMAND_MAX_LENGTH = 4000;
const SHELL_ENV_VARS_MAX = 200;
const SHELL_ENV_VAR_NAME_MAX = 256;
const SHELL_ENV_VAR_VALUE_MAX = 8000;
const SHELL_ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// How long a resolved environment is reused before the command runs again.
// The command is not run per spawn; it is run once and reused until this
// bound expires (or the config is edited, which invalidates the entry).
const PROJECT_SHELL_ENV_TTL_MS = 60_000;
// A spawn never waits longer than this for the environment. A command that
// overruns, exits non-zero, or cannot be parsed yields the base environment.
const PROJECT_SHELL_ENV_TIMEOUT_MS = 15_000;
// Directories and resolved environments are cached; bound the maps so a long
// running server cannot grow them without limit.
const PROJECT_SHELL_ENV_CACHE_MAX_ENTRIES = 500;

const OBJECT_TAG = '[object Object]';
const isObjectRecord = (value) => value != null && !Array.isArray(value) && Object.prototype.toString.call(value) === OBJECT_TAG;
const isString = (value) => String(value) === value;
const trimmedString = (value) => (isString(value) ? value.trim() : '');
const clamp = (value, maxLength) => (value.length > maxLength ? value.slice(0, maxLength) : value);

/**
 * Static variables a user typed: an object of `NAME` to string value. Names
 * must be valid environment identifiers; values are kept verbatim (capped).
 */
export const sanitizeShellEnvVars = (value) => {
  if (!isObjectRecord(value)) return {};
  const vars = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= SHELL_ENV_VARS_MAX) break;
    const key = clamp(trimmedString(rawKey), SHELL_ENV_VAR_NAME_MAX);
    if (!key || !SHELL_ENV_VAR_NAME_PATTERN.test(key)) continue;
    if (!isString(rawValue)) continue;
    vars[key] = clamp(rawValue, SHELL_ENV_VAR_VALUE_MAX);
    count += 1;
  }
  return vars;
};

/**
 * The stored `shellEnv` as a view, or `null` when the value carries nothing.
 * `enabled` is the explicit opt-in: a command never runs while it is false.
 */
export const sanitizeShellEnv = (value) => {
  if (!isObjectRecord(value)) return null;
  const enabled = value.enabled === true;
  const command = clamp(trimmedString(value.command), SHELL_ENV_COMMAND_MAX_LENGTH);
  const vars = sanitizeShellEnvVars(value.vars);
  const mode = value.mode === 'replace' ? 'replace' : 'overlay';
  if (!enabled && !command && Object.keys(vars).length === 0) return null;
  return { enabled, command, vars, mode };
};

/**
 * The on-disk shape: only the keys that carry something, and `mode` only when
 * it differs from the default. Returns `undefined` when nothing should be
 * stored so the key is dropped from the file.
 */
export const shellEnvToStored = (value) => {
  const shellEnv = sanitizeShellEnv(value);
  if (!shellEnv) return undefined;
  const stored = { enabled: shellEnv.enabled };
  if (shellEnv.command) stored.command = shellEnv.command;
  if (Object.keys(shellEnv.vars).length > 0) stored.vars = shellEnv.vars;
  if (shellEnv.mode === 'replace') stored.mode = 'replace';
  return stored;
};

// `nix print-dev-env --json` (`variables.NAME = { type, value }`) reports the
// derivation's whole environment, not just what a dev shell exports.
// `exported` is the only type that belongs in a child environment; `var`,
// `internal`, `array`, and `unknown` are the builder's own shell state (IFS,
// PS4, hook arrays) and adopting them would leak into every spawn.
const isExportedEntry = (entry) => isObjectRecord(entry) && entry.type === 'exported';

// That same derivation environment carries the Nix build sandbox's runtime
// identity: HOME points at `/homeless-shelter` and the temp directories at
// `NIX_BUILD_TOP`. devenv's own shell hook repairs these when it enters a
// shell; a plain spawn gets no such hook, so adopting them would follow every
// Git call, terminal, and Project Action and break tools that write under them
// (Go's build work dir, an interactive shell's own rc). Drop them, but only the
// sandbox values, so a project that genuinely sets its own HOME or TMPDIR keeps
// it. The temp names mirror devenv's hook.
const NIX_SANDBOX_HOME = '/homeless-shelter';
const SANDBOX_TEMP_VARIABLES = ['TMP', 'TMPDIR', 'TEMP', 'TEMPDIR'];
const stripNixBuildSandboxVars = (vars) => {
  const buildTop = vars.NIX_BUILD_TOP;
  delete vars.NIX_BUILD_TOP;
  if (vars.HOME === NIX_SANDBOX_HOME) delete vars.HOME;
  if (buildTop === undefined) return vars;
  for (const name of SANDBOX_TEMP_VARIABLES) {
    if (vars[name] === buildTop) delete vars[name];
  }
  return vars;
};

const extractJsonVariables = (parsed, out) => {
  // devenv `print-dev-env --json`: { variables: { NAME: { type, value } } }.
  const typedSource = isObjectRecord(parsed.variables) ? parsed.variables : null;
  const source = typedSource ?? parsed;
  if (!isObjectRecord(source)) return;
  if (typedSource) {
    for (const [key, entry] of Object.entries(source)) {
      if (!SHELL_ENV_VAR_NAME_PATTERN.test(key) || !isExportedEntry(entry)) continue;
      if (isString(entry.value)) out[key] = entry.value;
    }
    return;
  }
  for (const [key, entry] of Object.entries(source)) {
    if (!SHELL_ENV_VAR_NAME_PATTERN.test(key) || !isString(entry)) continue;
    out[key] = entry;
  }
};

const unquote = (value) => {
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
};

// Resolve `$NAME` / `${NAME}` against earlier lines of the same output, then
// the base environment. A reference neither can resolve stays literal, so a
// value is never silently emptied. Only `\$` is unescaped; other backslashes
// are left alone, because a Windows path must survive `export PATH="C:\Tools"`.
const expandVariables = (value, parsed, baseEnv) => value.replace(
  /\\\$|\$(\w+)|\$\{([^}]+)\}/g,
  (match, bare, braced) => {
    if (match === '\\$') return '$';
    const name = bare ?? braced;
    if (Object.prototype.hasOwnProperty.call(parsed, name)) return parsed[name];
    if (baseEnv && Object.prototype.hasOwnProperty.call(baseEnv, name)) return baseEnv[name];
    return match;
  },
);

const parseAssignment = (line, out, baseEnv) => {
  let entry = String(line ?? '').trim();
  if (!entry || entry.startsWith('#')) return;
  // `export NAME=value` is common in shell scripts; the prefix is cosmetic.
  entry = entry.replace(/^export\s+/, '');
  const equalsIndex = entry.indexOf('=');
  if (equalsIndex <= 0) return;
  const key = entry.slice(0, equalsIndex).trim();
  if (!SHELL_ENV_VAR_NAME_PATTERN.test(key)) return;
  const raw = unquote(entry.slice(equalsIndex + 1).trim());
  out[key] = expandVariables(raw, out, baseEnv);
};

/**
 * Parse the output of an environment-describing command. Tolerant by design:
 * unrecognized input produces an empty object rather than an error, so a
 * broken command can never break a spawn. Handles:
 *   - devenv `print-dev-env --json` (`variables.NAME.value`)
 *   - `direnv export json` and other flat JSON objects
 *   - `export NAME=value`, dotenv, and `env -0` output
 * `baseEnv` (optional) supplies values for `$NAME` references in line output.
 */
export const parseShellEnvOutput = (stdout, baseEnv = null) => {
  const text = isString(stdout) ? stdout : '';
  const out = {};
  const trimmed = text.trim();
  if (!trimmed) return out;

  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isObjectRecord(parsed)) {
        extractJsonVariables(parsed, out);
        if (Object.keys(out).length > 0) return stripNixBuildSandboxVars(out);
      }
    } catch {
      // Not JSON after all; fall through to line parsing.
    }
  }

  if (text.includes('\0')) {
    for (const chunk of text.split('\0')) parseAssignment(chunk, out, baseEnv);
    return stripNixBuildSandboxVars(out);
  }
  for (const line of text.split(/\r?\n/)) parseAssignment(line, out, baseEnv);
  return stripNixBuildSandboxVars(out);
};

const isPathLikeKey = (key) => {
  const upper = key.toUpperCase();
  return upper === 'PATH' || upper === 'CDPATH' || upper.endsWith('_PATH');
};

// The key to write a PATH-like value under: the base's own spelling when it
// has one (`Path` on Windows), so the child env never gets both `PATH` and
// `Path`.
const findExistingPathKey = (baseEnv, key) => {
  if (isString(baseEnv[key])) return key;
  const upper = key.toUpperCase();
  for (const baseKey of Object.keys(baseEnv)) {
    if (baseKey.toUpperCase() === upper) return baseKey;
  }
  return null;
};

// Deduplicating segment merge, project segments first.
const mergePathSegments = (primary, fallback, delimiter) => {
  const seen = new Set();
  const result = [];
  for (const value of [primary, fallback]) {
    if (!isString(value) || !value) continue;
    for (const segment of value.split(delimiter)) {
      if (!segment || seen.has(segment)) continue;
      seen.add(segment);
      result.push(segment);
    }
  }
  return result.join(delimiter);
};

/**
 * Overlay a resolved project environment onto a spawn's base environment.
 * PATH-like keys are prepended (deduplicated) in `overlay` mode so system
 * tools stay reachable; `replace` mode sets them verbatim. Other keys always
 * override. Returns `baseEnv` unchanged when there is nothing to apply.
 */
export const applyShellEnv = (baseEnv, resolved, delimiter = ':') => {
  if (!resolved) return baseEnv;
  const mode = resolved.mode === 'replace' ? 'replace' : 'overlay';
  const next = { ...baseEnv };
  for (const [key, value] of Object.entries(resolved.vars)) {
    if (!isString(value)) continue;
    if (mode !== 'replace' && isPathLikeKey(key)) {
      const existingKey = findExistingPathKey(baseEnv, key) ?? key;
      const baseValue = isString(baseEnv[existingKey]) ? baseEnv[existingKey] : '';
      next[existingKey] = baseValue ? mergePathSegments(value, baseValue, delimiter) : value;
      continue;
    }
    next[key] = value;
  }
  return next;
};

const runCommandWithTimeout = ({ spawn, command, cwd, env, timeoutMs }) => new Promise((resolve) => {
  let stdout = '';
  let settled = false;
  let timer = null;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(value);
  };

  let child;
  try {
    child = spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    resolve(null);
    return;
  }

  timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    finish(null);
  }, timeoutMs);

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
    // A runaway command that prints forever is cut off at a sane bound.
    if (stdout.length > SHELL_ENV_VAR_VALUE_MAX * SHELL_ENV_VARS_MAX) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }
  });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code === 0 ? stdout : null));
});

/**
 * Create the shared resolver. Dependencies:
 *   - `fsPromises`, `path`, `projectsDirPath`: to locate the owning project.
 *   - `readShellEnvForProject(projectId)`: the personal `shellEnv` (or null).
 *   - `createProjectIdFromPath`, `projectConfigFileStemOf`: id/naming rules.
 *   - `spawn`, `baseEnv()` (called at spawn time): to run the command.
 * The resolver never throws at a spawn: any failure resolves to `null`.
 */
export const createProjectShellEnvResolver = (dependencies) => {
  const {
    fsPromises,
    path,
    projectsDirPath,
    readShellEnvForProject,
    createProjectIdFromPath,
    projectConfigFileStemOf = (projectId) => projectId,
    spawn,
    baseEnv = () => process.env,
    timeoutMs = PROJECT_SHELL_ENV_TIMEOUT_MS,
    ttlMs = PROJECT_SHELL_ENV_TTL_MS,
    now = Date.now,
    logger = console,
  } = dependencies;

  const envCache = new Map();
  const inFlight = new Map();
  // Bumped when a project's config is edited: a resolution that started before
  // the bump is used once but not cached, so the edit applies next spawn.
  const generations = new Map();

  const configPathFor = (projectId) => path.join(projectsDirPath, `${projectConfigFileStemOf(projectId)}.json`);

  const statOrNull = async (filePath) => {
    try {
      return await fsPromises.stat(filePath);
    } catch {
      return null;
    }
  };

  const setBounded = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > PROJECT_SHELL_ENV_CACHE_MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  const projectGeneration = (projectId) => generations.get(projectId) ?? 0;
  const bumpGeneration = (projectId) => generations.set(projectId, projectGeneration(projectId) + 1);

  // The checkout root of `directory`: the nearest ancestor that has a `.git`
  // entry. A linked worktree's `.git` is a file whose `gitdir:` points at the
  // primary repository, which is how a worktree inherits the project's env.
  const resolveCheckoutRoot = async (directory) => {
    let current = directory;
    for (;;) {
      const gitEntry = await statOrNull(path.join(current, '.git'));
      if (gitEntry) return { checkoutRoot: current, gitEntry };
      const parent = path.dirname(current);
      if (!parent || parent === current) return null;
      current = parent;
    }
  };

  // Mirror of `derivePrimaryWorktreeRootFromGitDir` in `lib/git/service.js`
  // (kept local so this module does not depend on the Git service, which
  // depends on this one). A linked worktree's git dir is
  // `<primary>/.git/worktrees/<name>`.
  const derivePrimaryRootFromGitDir = (rawGitDir, checkoutRoot) => {
    const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(checkoutRoot, rawGitDir);
    const normalized = gitDir.replace(/\\/g, '/');
    if (normalized.endsWith('/.git')) return normalized.slice(0, -'/.git'.length);
    const marker = '/.git/worktrees/';
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex > 0) return normalized.slice(0, markerIndex);
    return null;
  };

  const primaryRootFor = async ({ checkoutRoot, gitEntry }) => {
    if (!gitEntry.isFile()) return checkoutRoot;
    const content = await fsPromises.readFile(path.join(checkoutRoot, '.git'), 'utf8').catch(() => '');
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) return checkoutRoot;
    return derivePrimaryRootFromGitDir(match[1].trim(), checkoutRoot) || checkoutRoot;
  };

  // The nearest ancestor with a project config file, or null.
  const findNearestProjectConfig = async (directory) => {
    let current = directory;
    for (;;) {
      const projectId = createProjectIdFromPath(current);
      if (projectId && await statOrNull(configPathFor(projectId))) {
        return { projectId, projectPath: current };
      }
      const parent = path.dirname(current);
      if (!parent || parent === current) return null;
      current = parent;
    }
  };

  /**
   * Which project's `shellEnv` applies to `directory`, and where the command
   * runs. A linked worktree inherits the primary project's settings but runs
   * the command in its own checkout, so devenv/direnv sees this worktree. The
   * primary config wins when both it and the checkout have one; a worktree
   * with its own enabled config is used when the primary has none.
   */
  const resolveEnabledTarget = async (directory) => {
    const checkout = await resolveCheckoutRoot(directory);
    const candidateRoots = new Set();
    if (checkout) {
      const primaryRoot = await primaryRootFor(checkout);
      if (primaryRoot) candidateRoots.add(primaryRoot);
    }
    const nearest = await findNearestProjectConfig(directory);
    if (nearest) candidateRoots.add(nearest.projectPath);

    for (const candidateRoot of candidateRoots) {
      const projectId = createProjectIdFromPath(candidateRoot);
      if (!projectId || !(await statOrNull(configPathFor(projectId)))) continue;
      const shellEnv = await readShellEnvForProject(projectId);
      if (shellEnv?.enabled !== true) continue;
      return {
        projectId,
        shellEnv,
        executionRoot: checkout ? checkout.checkoutRoot : candidateRoot,
      };
    }
    return null;
  };

  const computeResolved = async (target) => {
    const currentBaseEnv = baseEnv();
    let commandVars = {};
    if (target.shellEnv.command) {
      const output = await runCommandWithTimeout({
        spawn,
        command: target.shellEnv.command,
        cwd: target.executionRoot,
        env: { ...currentBaseEnv },
        timeoutMs,
      });
      // A failing or overrunning command leaves the spawn on its base env.
      if (output === null) return null;
      commandVars = parseShellEnvOutput(output, currentBaseEnv);
    }

    // Explicitly configured variables win over parsed output, so a user can
    // correct a single value without fighting the tool.
    const vars = { ...commandVars, ...target.shellEnv.vars };
    if (Object.keys(vars).length === 0) return null;
    return { vars, mode: target.shellEnv.mode };
  };

  const resolveForDirectory = async (directory) => {
    const resolvedDirectory = isString(directory) && directory.trim() ? path.resolve(directory) : '';
    if (!resolvedDirectory) return null;

    const at = now();
    const cached = envCache.get(resolvedDirectory);
    if (cached && at - cached.at < ttlMs) {
      // Keep the LRU position fresh.
      envCache.delete(resolvedDirectory);
      envCache.set(resolvedDirectory, cached);
      return cached.resolved;
    }

    const pending = inFlight.get(resolvedDirectory);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const target = await resolveEnabledTarget(resolvedDirectory);
        const projectId = target?.projectId ?? null;
        const generationAtStart = projectId ? projectGeneration(projectId) : 0;
        const resolved = target ? await computeResolved(target) : null;
        // If the config changed while the command ran, the result is stale:
        // use it for this spawn, but do not cache it.
        if (!projectId || projectGeneration(projectId) === generationAtStart) {
          setBounded(envCache, resolvedDirectory, { at: now(), resolved, projectId });
        }
        return resolved;
      } catch (error) {
        logger.warn(`[shell-env] failed to resolve environment for ${resolvedDirectory}: ${error instanceof Error ? error.message : String(error)}`);
        setBounded(envCache, resolvedDirectory, { at: now(), resolved: null, projectId: null });
        return null;
      }
    })().finally(() => {
      if (inFlight.get(resolvedDirectory) === promise) inFlight.delete(resolvedDirectory);
    });

    inFlight.set(resolvedDirectory, promise);
    return promise;
  };

  // Drop everything cached for one project (its config was edited). Called by
  // the project config route so a change applies on the next spawn.
  const invalidateProject = (projectId) => {
    if (!projectId) return;
    bumpGeneration(projectId);
    for (const [directory, entry] of envCache) {
      if (entry?.projectId === projectId) envCache.delete(directory);
    }
  };

  const clear = () => {
    envCache.clear();
    inFlight.clear();
    generations.clear();
  };

  return { resolveForDirectory, invalidateProject, clear };
};
