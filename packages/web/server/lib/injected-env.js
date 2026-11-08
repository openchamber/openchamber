/**
 * Variables OpenChamber puts into an environment other processes inherit: its
 * own host process (the desktop app, `serve --foreground`), the managed
 * OpenCode server, and through them the integrated terminal and an agent's
 * shell. Every such write goes through `assignInjectedEnv`, which also records
 * the variable's name in `OPENCHAMBER_INJECTED_ENV`. A command run from one of
 * those shells (`openchamber startup enable`) reads the record to tell
 * OpenChamber's configuration from what the user exported, with no list of
 * names that could drift from the code that sets them (#4604).
 *
 * A write that leaves the value as it was is not recorded: the shell already
 * had that value, so it is the user's, and a user's `OPENCODE_PASSWORD` that
 * OpenChamber passes through to the managed OpenCode stays theirs.
 */

export const INJECTED_ENV_KEY = 'OPENCHAMBER_INJECTED_ENV';

/**
 * Names recorded in `env`, plus the record itself. Empty when nothing was.
 * @param {Record<string, string | undefined>} env
 * @returns {Set<string>}
 */
export function injectedEnvKeys(env) {
  const record = env[INJECTED_ENV_KEY] ?? '';
  if (record.length === 0) return new Set();
  const keys = new Set(record.split(',').filter((key) => key.length > 0));
  keys.add(INJECTED_ENV_KEY);
  return keys;
}

/**
 * `env` without what OpenChamber put into it, for a server started from such
 * a shell: it is its own instance, not the one whose shell it runs in. What
 * the user exported is not in the record and stays.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function withoutInjectedEnv(env) {
  const injected = injectedEnvKeys(env);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !injected.has(key)));
}

/**
 * A copy of `env` with `values` set as the user's own: their names leave the
 * record, so a command started with it takes them as given.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} values
 * @returns {Record<string, string | undefined>}
 */
export function withUserEnv(env, values) {
  const next = { ...env, ...values };
  const recorded = injectedEnvKeys(env);
  recorded.delete(INJECTED_ENV_KEY);
  for (const key of Object.keys(values)) recorded.delete(key);
  if (recorded.size > 0) next[INJECTED_ENV_KEY] = [...recorded].join(',');
  else delete next[INJECTED_ENV_KEY];
  return next;
}

/**
 * Set each defined value in `env` and record the names whose value changed.
 * @template {Record<string, string | undefined>} T
 * @param {T} env
 * @param {Record<string, string | undefined>} values
 * @returns {T}
 */
export function assignInjectedEnv(env, values) {
  const recorded = injectedEnvKeys(env);
  recorded.delete(INJECTED_ENV_KEY);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || env[key] === value) continue;
    env[key] = value;
    recorded.add(key);
  }
  if (recorded.size > 0) {
    env[INJECTED_ENV_KEY] = [...recorded].join(',');
  }
  return env;
}
