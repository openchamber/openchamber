import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AGENT_SCOPE, getJsonWriteTarget, readConfigLayers, writeConfig } from './config-files.js';
import { findProjectConfigOverride } from './config-v2.js';
import { readProjectConfigFiles } from './websearch-config.js';

const delivery = z.enum(['none', 'inbox', 'wake']);
const positiveInt = z.number().int().positive();

// Mirrors `ConfigMessaging.Info` in OpenCode's config schema. Unknown keys are
// refused so a typo is reported here instead of being written to the file.
const MessagingSchema = z.strictObject({
  presets: z.record(z.string(), z.string()).optional(),
  vars: z.record(z.string(), z.string()).optional(),
  session_start: z.string().optional(),
  delivery: z.strictObject({
    direct: delivery.optional(),
    root: delivery.optional(),
    user: z.enum(['hidden', 'visible', 'wake']).optional(),
  }).optional(),
  search: z.strictObject({
    match: z.enum(['exact', 'regex', 'fuzzy', 'semantic', 'hybrid', 'advanced']).optional(),
    model: z.string().optional(),
  }).optional(),
  embedding: z.union([
    z.string().min(1),
    z.strictObject({
      tier: z.string().optional(),
      url: z.string().optional(),
      path: z.string().optional(),
      pooling: z.enum(['last', 'mean', 'cls']).optional(),
      query: z.string().optional(),
      server: z.string().optional(),
      autostart: z.boolean().optional(),
      gpu_layers: z.number().int().optional(),
      threads: positiveInt.optional(),
      remote: z.strictObject({
        url: z.string(),
        model: z.string(),
        key: z.string().optional(),
        dimensions: positiveInt.optional(),
      }).optional(),
    }),
  ]).optional(),
});

/**
 * Checks a `messaging` value from a request body. `null` means remove the key.
 * Returns `{ value }` with the value as given, or `{ error }` naming the first
 * offending path, such as `messaging.delivery.direct`.
 */
export function parseMessagingConfig(value) {
  if (value === undefined) return { error: 'messaging is required: an object, or null to remove it' };
  if (value === null) return { value: null };
  const result = MessagingSchema.safeParse(value);
  if (!result.success) return { error: describeIssue(result.error.issues[0], ['messaging']) };
  return { value };
}

/**
 * The `messaging` section in the file Settings writes, `OPENCODE_CONFIG` when
 * set, else the user's global `opencode.json`. `projectPath` is the project
 * config whose `messaging` overrides that file for `directory`, or `null`.
 */
export function getMessagingConfig(directory) {
  const target = getJsonWriteTarget(readConfigLayers(null), AGENT_SCOPE.USER);
  return {
    messaging: target.config.messaging ?? null,
    path: target.path,
    projectPath: findProjectConfigOverride('messaging', readConfigLayers(directory), readProjectConfigFiles(directory)),
  };
}

/**
 * Writes `messaging` from `parseMessagingConfig` into the file Settings
 * writes; `null` removes the key. OpenCode watches the file and applies the
 * section without a restart. The file is left untouched when it already holds
 * the same value.
 */
export function setMessagingConfig(value) {
  const target = getJsonWriteTarget(readConfigLayers(null), AGENT_SCOPE.USER);
  const changed = !isDeepStrictEqual(target.config.messaging ?? null, value);
  if (changed) {
    if (value === null) delete target.config.messaging;
    else target.config.messaging = value;
    writeConfig(target.config, target.path);
  }
  return { messaging: value, path: target.path, changed };
}

// A union reports one error per branch; the branch that matched the value's
// type holds the useful one, so follow it to name the deepest path.
function describeIssue(issue, prefix) {
  const issuePath = [...prefix, ...issue.path];
  if (issue.code === 'invalid_union') {
    const branch = issue.errors.find((errors) => !(errors[0]?.code === 'invalid_type' && errors[0].path.length === 0));
    if (branch) return describeIssue(branch[0], issuePath);
  }
  if (issue.code === 'unrecognized_keys') return `${[...issuePath, issue.keys[0]].join('.')}: unknown key`;
  return `${issuePath.join('.')}: ${issue.message}`;
}
