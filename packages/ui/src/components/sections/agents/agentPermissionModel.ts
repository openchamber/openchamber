import type { PermissionEffect, PermissionRule } from '@/stores/useAgentsStore';


export const EFFECTS: PermissionEffect[] = ['allow', 'ask', 'deny'];

export const BUILTIN_ACTIONS = [
  'shell',
  'edit',
  'read',
  'glob',
  'grep',
  'patch',
  'webfetch',
  'websearch',
  'skill',
  'subagent',
  'question',
  'external_directory',
] as const;

export const OPENCHAMBER_ACTIONS = ['openchamber', 'openchamber_schedule', 'openchamber_web', 'openchamber_memory', 'openchamber_knowledge', 'openchamber_notify', 'openchamber_usage', 'openchamber_actions', 'openchamber_render', 'openchamber_image', 'openchamber_secret'] as const;

const LEGACY_ACTIONS: ReadonlySet<string> = new Set([
  'bash',
  'task',
  'write',
  'list',
  'lsp',
  'todowrite',
  'todoread',
  'multiedit',
  'doom_loop',
  'plan_enter',
  'plan_exit',
]);

const isLegacyAction = (action: string): boolean => LEGACY_ACTIONS.has(action);

const OPENCODE_DEFAULT_RULES: readonly PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
];

export interface PatternRule {
  pattern: string;
  effect: PermissionEffect;
}

export interface KeyState {
  effect: PermissionEffect | null;
  patterns: PatternRule[];
}

export interface PermissionModel {
  global: PermissionEffect | null;
  keys: Record<string, KeyState>;
  source: readonly PermissionRule[];
}

export const emptyModel = (): PermissionModel => ({ global: null, keys: {}, source: [] });

export const cloneModel = (model: PermissionModel): PermissionModel => ({
  global: model.global,
  source: model.source,
  keys: Object.fromEntries(
    Object.entries(model.keys).map(([key, state]) => [
      key,
      { effect: state.effect, patterns: state.patterns.map((entry) => ({ ...entry })) },
    ]),
  ),
});

export const parseRules = (rules: readonly PermissionRule[]): PermissionModel => {
  const model: PermissionModel = { global: null, keys: {}, source: rules.map((rule) => ({ ...rule })) };
  for (const rule of rules) {
    if (isLegacyAction(rule.action)) continue;
    if (rule.action === '*') {
      if (rule.resource === '*') model.global = rule.effect;
      continue;
    }
    const state = model.keys[rule.action] ?? { effect: null, patterns: [] };
    if (rule.resource === '*') {
      state.effect = rule.effect;
    } else {
      const existing = state.patterns.findIndex((entry) => entry.pattern === rule.resource);
      if (existing >= 0) state.patterns[existing] = { pattern: rule.resource, effect: rule.effect };
      else state.patterns.push({ pattern: rule.resource, effect: rule.effect });
    }
    model.keys[rule.action] = state;
  }
  return model;
};

const isViewRule = (rule: PermissionRule): boolean => rule.action !== '*' || rule.resource === '*';

const ruleKey = (action: string, resource: string): string => `${action}\u0000${resource}`;

const wantedEffects = (model: PermissionModel): Map<string, PermissionEffect> => {
  const wanted = new Map<string, PermissionEffect>();
  if (model.global !== null) wanted.set(ruleKey('*', '*'), model.global);
  for (const [action, state] of Object.entries(model.keys)) {
    if (state.effect !== null) wanted.set(ruleKey(action, '*'), state.effect);
    for (const entry of state.patterns) {
      const pattern = entry.pattern.trim();
      if (pattern.length === 0) continue;
      wanted.set(ruleKey(action, pattern), entry.effect);
    }
  }
  return wanted;
};

export const serializeRules = (model: PermissionModel): PermissionRule[] => {
  const wanted = wantedEffects(model);
  const emitted = new Set<string>();
  const rules: PermissionRule[] = [];
  for (const rule of model.source) {
    if (isLegacyAction(rule.action)) continue;
    if (!isViewRule(rule)) {
      rules.push({ ...rule });
      continue;
    }
    const key = ruleKey(rule.action, rule.resource);
    const effect = wanted.get(key);
    if (effect === undefined) continue;
    rules.push({ action: rule.action, resource: rule.resource, effect });
    emitted.add(key);
  }

  const globalKey = ruleKey('*', '*');
  if (model.global !== null && !emitted.has(globalKey)) {
    rules.unshift({ action: '*', resource: '*', effect: model.global });
  }

  for (const [action, state] of Object.entries(model.keys)) {
    const wildcardKey = ruleKey(action, '*');
    if (state.effect !== null && !emitted.has(wildcardKey)) {
      const firstOfTool = rules.findIndex((rule) => rule.action === action);
      const wildcard = { action, resource: '*', effect: state.effect };
      if (firstOfTool >= 0) rules.splice(firstOfTool, 0, wildcard);
      else rules.push(wildcard);
    }
    for (const entry of state.patterns) {
      const pattern = entry.pattern.trim();
      if (pattern.length === 0) continue;
      const key = ruleKey(action, pattern);
      const effect = wanted.get(key);
      if (effect === undefined || emitted.has(key)) continue;
      emitted.add(key);
      rules.push({ action, resource: pattern, effect });
    }
  }
  return rules;
};

export const modelsEqual = (a: PermissionModel, b: PermissionModel): boolean =>
  JSON.stringify(serializeRules(a)) === JSON.stringify(serializeRules(b));

export const effectiveEffect = (
  action: string,
  layers: { global: readonly PermissionRule[]; agentGlobal: PermissionEffect | null },
): PermissionEffect => {
  const combined: PermissionRule[] = [
    ...OPENCODE_DEFAULT_RULES,
    ...layers.global,
    ...(layers.agentGlobal ? [{ action: '*', resource: '*', effect: layers.agentGlobal }] : []),
  ];
  let effect: PermissionEffect = 'ask';
  for (const rule of combined) {
    if (rule.resource !== '*') continue;
    if (rule.action === '*' || rule.action === action) effect = rule.effect;
  }
  return effect;
};
