import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

export type ManagedRule = {
  action: string;
  resource: string;
  effect: string;
};
export type ManagedCommand = {
  description: string;
  template: string;
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype;

const matchesEntry = (value: JsonValue, pluginDirectory: string) => (
  value === pluginDirectory || (Array.isArray(value) && value[0] === pluginDirectory)
);

const parseConfigContent = (rawConfig: string | undefined, purpose: string) => {
  const errors: ParseError[] = [];
  const text = (rawConfig ?? '').trim();
  const parsed: JsonValue = text ? parseJsonc(text, errors, { allowTrailingComma: true }) : {};
  if (errors.length > 0 || !isJsonObject(parsed)) {
    throw new Error(`OPENCODE_CONFIG_CONTENT must contain a valid JSON object before OpenChamber can inject its ${purpose}`);
  }
  return parsed;
};

export const appendManagedPlugin = (rawConfig: string | undefined, pluginDirectory: string, purpose: string) => {
  const parsed = parseConfigContent(rawConfig, purpose);
  for (const key of ['plugin', 'plugins']) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
      throw new Error(`OPENCODE_CONFIG_CONTENT ${key} must be an array before OpenChamber can inject its ${purpose}`);
    }
  }
  const configured = [
    ...(Array.isArray(parsed.plugin) ? parsed.plugin : []),
    ...(Array.isArray(parsed.plugins) ? parsed.plugins : []),
  ];
  delete parsed.plugin;
  parsed.plugins = [
    ...configured.filter((value) => !matchesEntry(value, pluginDirectory)),
    pluginDirectory,
  ];
  return JSON.stringify(parsed);
};

const sameRule = (left: JsonValue, right: ManagedRule) => isJsonObject(left)
  && left.action === right.action && left.resource === right.resource && left.effect === right.effect;

export const appendManagedPermissions = (rawConfig: string | undefined, rules: ManagedRule[]) => {
  const parsed = parseConfigContent(rawConfig, 'managed tool permissions');
  if (parsed.permissions !== undefined && !Array.isArray(parsed.permissions)) {
    throw new Error('OPENCODE_CONFIG_CONTENT permissions must be an array before OpenChamber can inject its managed tool permissions');
  }
  const configured = Array.isArray(parsed.permissions) ? parsed.permissions : [];
  parsed.permissions = [
    ...configured.filter((existing) => !rules.some((rule) => sameRule(existing, rule))),
    ...rules,
  ];
  return JSON.stringify(parsed);
};

export const appendManagedSkills = (rawConfig: string | undefined, directories: string[]) => {
  const parsed = parseConfigContent(rawConfig, 'managed skills');
  if (parsed.skills !== undefined && !Array.isArray(parsed.skills)) {
    throw new Error('OPENCODE_CONFIG_CONTENT skills must be an array before OpenChamber can inject its managed skills');
  }
  const configured = Array.isArray(parsed.skills) ? parsed.skills : [];
  parsed.skills = [...configured.filter((existing) => !directories.some((directory) => directory === existing)), ...directories];
  return JSON.stringify(parsed);
};

export const appendManagedCommand = (rawConfig: string | undefined, name: string, command: ManagedCommand) => {
  const parsed = parseConfigContent(rawConfig, 'managed commands');
  if (parsed.commands !== undefined && !isJsonObject(parsed.commands)) {
    throw new Error('OPENCODE_CONFIG_CONTENT commands must be an object before OpenChamber can inject its managed commands');
  }
  parsed.commands = { [name]: command, ...parsed.commands };
  return JSON.stringify(parsed);
};

export const appendManagedPolicies = (rawConfig: string | undefined, policies: ManagedRule[]) => {
  const parsed = parseConfigContent(rawConfig, 'plugin switches');
  if (parsed.policies !== undefined && !Array.isArray(parsed.policies)) {
    throw new Error('OPENCODE_CONFIG_CONTENT policies must be an array before OpenChamber can inject its plugin switches');
  }
  const configured = Array.isArray(parsed.policies) ? parsed.policies : [];
  parsed.policies = [
    ...configured.filter((existing) => !policies.some((rule) => sameRule(existing, rule))),
    ...policies,
  ];
  return JSON.stringify(parsed);
};
