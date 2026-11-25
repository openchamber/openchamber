// Process-global singletons keyed per profile config (IA 3, 6.6, 10.4). Kept on `globalThis`, so a
// plugin reload that imports a fresh copy of this module still finds the instances of the old copy.

import { LOG_PREFIX } from "./config.ts";
import { getField } from "./fs-utils.ts";

const REGISTRY_KEY = Symbol.for("openchamber.opencode-antigravity.singletons.v1");

interface Registry {
  version: 1;
  entries: Map<string, unknown>;
  /** Profile keys seen per kind, to log the two-configurations line once. */
  keys: Map<string, Set<string>>;
  warned: boolean;
}

function isRegistry(value: unknown): value is Registry {
  return getField(value, "version") === 1 && getField(value, "entries") instanceof Map && getField(value, "keys") instanceof Map;
}

function registry(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (isRegistry(existing)) return existing;
  const created: Registry = { version: 1, entries: new Map(), keys: new Map(), warned: false };
  Reflect.set(globalThis, REGISTRY_KEY, created);
  return created;
}

export const TWO_CONFIGS_MESSAGE = `${LOG_PREFIX} Two plugin configurations are active in one OpenCode process; they use separate profiles.`;

/**
 * The instance of `kind` for `key`, created on first use. `isInstance` checks a brand field, so an
 * instance made by an older copy of the module is reused. A second key for the same kind logs
 * `TWO_CONFIGS_MESSAGE` once per process.
 */
export function processSingleton<T>(
  kind: string,
  key: string,
  create: () => T,
  isInstance: (value: unknown) => value is T,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): T {
  const reg = registry();
  const entryKey = `${kind}\0${key}`;
  const existing = reg.entries.get(entryKey);
  if (isInstance(existing)) return existing;
  const keys = reg.keys.get(kind) ?? new Set<string>();
  reg.keys.set(kind, keys);
  keys.add(key);
  if (keys.size > 1 && !reg.warned) {
    reg.warned = true;
    log(TWO_CONFIGS_MESSAGE);
  }
  const created = create();
  reg.entries.set(entryKey, created);
  return created;
}

/** Test helper: forgets every singleton and the warning flag. */
export function resetProcessSingletons(): void {
  Reflect.deleteProperty(globalThis, REGISTRY_KEY);
}
