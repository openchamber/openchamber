export const INJECTED_ENV_KEY: 'OPENCHAMBER_INJECTED_ENV';

export function injectedEnvKeys(env: Record<string, string | undefined>): Set<string>;

export function withoutInjectedEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;

export function withUserEnv(env: Record<string, string | undefined>, values: Record<string, string>): Record<string, string | undefined>;

export function assignInjectedEnv<T extends Record<string, string | undefined>>(
  env: T,
  values: Record<string, string | undefined>,
): T;
