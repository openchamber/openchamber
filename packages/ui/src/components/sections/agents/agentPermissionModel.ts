import type { PermissionConfig } from '@opencode-ai/sdk/v2';

/**
 * Editor model for an agent's OWN `permission` map (the source config), with
 * lossless parse/serialize between the persisted shape and the model.
 * "null" action = key/pattern not set → inherited from global config/defaults.
 */
export type Action = 'allow' | 'ask' | 'deny';

export const ACTIONS: Action[] = ['allow', 'ask', 'deny'];

export interface KeyState {
  /** Explicit action for the key's `*` pattern; null = not set (inherit). */
  action: Action | null;
  /** Non-wildcard pattern rules, in stable order. */
  patterns: Array<{ pattern: string; action: Action }>;
}

export interface PermissionModel {
  /** Explicit agent-level default (the `*` key); null = inherit. */
  global: Action | null;
  keys: Record<string, KeyState>;
}

/** Effective (resolved) rule as returned by /agent. */
export interface EffectiveRule {
  permission: string;
  pattern: string;
  action: Action;
}

export const isAction = (value: unknown): value is Action =>
  value === 'allow' || value === 'ask' || value === 'deny';

export const emptyModel = (): PermissionModel => ({ global: null, keys: {} });

/** Parse the persisted PermissionConfig into the editor model, verbatim. */
export const parsePermissionConfig = (config: unknown): PermissionModel => {
  const model = emptyModel();
  if (config == null) return model;
  if (typeof config === 'string') {
    if (isAction(config)) model.global = config;
    return model;
  }
  if (typeof config !== 'object' || Array.isArray(config)) return model;

  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (key === '*') {
      if (isAction(value)) model.global = value;
      continue;
    }
    const state: KeyState = { action: null, patterns: [] };
    if (isAction(value)) {
      state.action = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
        if (!isAction(action)) continue;
        if (pattern === '*') {
          state.action = action;
        } else {
          state.patterns.push({ pattern, action });
        }
      }
    } else {
      continue;
    }
    model.keys[key] = state;
  }
  return model;
};

/** Serialize the editor model back to the persisted shape (canonical form). */
export const serializePermissionModel = (model: PermissionModel): PermissionConfig | null => {
  const result: Record<string, Action | Record<string, Action>> = {};
  if (model.global !== null) {
    result['*'] = model.global;
  }
  for (const [key, state] of Object.entries(model.keys)) {
    const patterns = state.patterns.filter((rule) => rule.pattern.trim().length > 0);
    if (state.action !== null && patterns.length === 0) {
      result[key] = state.action;
    } else if (patterns.length > 0) {
      const nested: Record<string, Action> = {};
      if (state.action !== null) nested['*'] = state.action;
      for (const rule of patterns) nested[rule.pattern] = rule.action;
      result[key] = nested;
    }
    // action === null && no patterns → key omitted entirely (inherit)
  }
  return Object.keys(result).length > 0 ? (result as PermissionConfig) : null;
};

export const modelsEqual = (a: PermissionModel, b: PermissionModel): boolean =>
  JSON.stringify(serializePermissionModel(a)) === JSON.stringify(serializePermissionModel(b));

export const cloneModel = (model: PermissionModel): PermissionModel =>
  JSON.parse(JSON.stringify(model)) as PermissionModel;
