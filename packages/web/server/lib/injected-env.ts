import type { JsonValue } from './shared/json-values.js';
export const INJECTED_ENV_KEY = 'OPENCHAMBER_INJECTED_ENV';

export function injectedEnvKeys(env: NodeJS.ProcessEnv): Set<string> {
  const record = env[INJECTED_ENV_KEY] ?? '';
  if (record.length === 0) return new Set();
  const keys = new Set(record.split(',').filter((key) => key.length > 0));
  keys.add(INJECTED_ENV_KEY);
  return keys;
}

export function withoutInjectedEnv(env: NodeJS.ProcessEnv) {
  const injected = injectedEnvKeys(env);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !injected.has(key)));
}

export function withUserEnv<Value extends JsonValue>(env: NodeJS.ProcessEnv, values: Record<string, Value>) {
  const next = { ...env, ...values };
  const recorded = injectedEnvKeys(env);
  recorded.delete(INJECTED_ENV_KEY);
  for (const key of Object.keys(values)) recorded.delete(key);
  if (recorded.size > 0) next[INJECTED_ENV_KEY] = [...recorded].join(',');
  else delete next[INJECTED_ENV_KEY];
  return next;
}

export function assignInjectedEnv(env: NodeJS.ProcessEnv, values: NodeJS.ProcessEnv) {
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
