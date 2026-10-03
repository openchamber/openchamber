import type { PermissionEffect, PermissionRule } from '@/stores/useAgentsStore';

/**
 * Editor model for an agent's permissions.
 *
 * OpenCode v2 stores an ORDERED list of `{ action, resource, effect }` rules
 * where the last match wins. The user does not think in ordered rules; they
 * think "what may this agent do with each tool?". So the editor keeps the v1
 * mental model — one row per tool with inherit / allow / ask / deny, plus
 * optional resource patterns under a row — and this module translates that
 * view to and from the rule list.
 *
 * Because the last match wins, the ORDER of the stored list is part of the
 * policy: rebuilding it from the per-tool view would silently change what
 * OpenCode decides for tools the user never touched. So the model keeps the
 * list it was read from and a save edits that list in place: a changed effect
 * replaces the rule where it stands, a removed row drops its rules, rules the
 * view cannot show (an `*` action with a resource pattern) stay untouched, and
 * only rules the user newly created are inserted, at a position that changes
 * nothing but the tool they belong to.
 */

export const EFFECTS: PermissionEffect[] = ['allow', 'ask', 'deny'];

/**
 * Permission actions the built-in v2 tools check, in the order they are
 * listed. Plugins and MCP servers add their own (`<server>_<tool>`), which
 * appear as rows once the agent's rules or the tool catalog mention them.
 */
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

/** OpenChamber's own agent tools, shown so their rules are discoverable. */
export const OPENCHAMBER_ACTIONS = ['openchamber', 'openchamber_web', 'openchamber_memory', 'openchamber_notify'] as const;

/**
 * v1 permission keys OpenCode 2 no longer checks. Rules on them are inert, so
 * the editor neither shows nor writes them back: the next save drops them.
 */
export const LEGACY_ACTIONS: ReadonlySet<string> = new Set([
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

export const isLegacyAction = (action: string): boolean => LEGACY_ACTIONS.has(action);

/**
 * The ordered base policy every agent starts with (OpenCode docs,
 * "Permissions → Defaults"). Global config rules come after it and the agent's
 * own rules last.
 */
export const OPENCODE_DEFAULT_RULES: readonly PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
];

export interface PatternRule {
  pattern: string;
  effect: PermissionEffect;
}

export interface KeyState {
  /** The tool's own `*` rule; null = not set, so lower layers decide. */
  effect: PermissionEffect | null;
  /** Resource patterns for the tool, in stable order. */
  patterns: PatternRule[];
}

export interface PermissionModel {
  /** The agent's `*` / `*` rule; null = not set. */
  global: PermissionEffect | null;
  keys: Record<string, KeyState>;
  /**
   * The stored rule list this view was read from, in evaluation order.
   * `serializeRules` edits it rather than rebuilding it. Never mutated.
   */
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

/**
 * Read the agent's stored rule list into the per-tool view. Legacy v1 keys are
 * dropped here on purpose (see `LEGACY_ACTIONS`). When a tool has several
 * rules for the same resource the last one wins, which is also what OpenCode
 * evaluates. Rules the view cannot show stay in `source` and are written back
 * unchanged.
 */
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

/** A stored rule the per-tool view shows as a row or a pattern under one. */
const isViewRule = (rule: PermissionRule): boolean => rule.action !== '*' || rule.resource === '*';

const ruleKey = (action: string, resource: string): string => `${action}\u0000${resource}`;

/**
 * The effect the view wants for every (action, resource) it represents. Blank
 * patterns are dropped; a pattern listed twice keeps its last effect.
 */
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

/**
 * Write the per-tool view back as the stored list with the user's edits
 * applied in place, so decisions for everything the user did not touch stay
 * exactly what they were:
 *
 * - a rule the view still shows is kept where it stands, with its current effect;
 * - a rule whose row or pattern the user removed is dropped;
 * - a rule the view cannot show is kept untouched;
 * - legacy v1 keys are dropped (see `LEGACY_ACTIONS`);
 * - a new agent wildcard goes first, so every existing rule still refines it;
 * - a new tool wildcard goes right before that tool's first existing rule, so
 *   the tool's patterns keep overriding it; with no such rule it goes last;
 * - a new pattern goes last, so it wins for the resources it names.
 */
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

/**
 * What OpenCode would decide for a tool (any resource) given the layers below
 * the agent's own row: defaults, global config, and the agent's `*` rule.
 * Later rules win; a tool-specific wildcard beats a `*` wildcard only by
 * coming later in that combined list, which mirrors OpenCode's evaluation.
 */
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
