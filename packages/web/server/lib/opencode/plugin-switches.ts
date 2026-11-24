import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord, isString } from '../shared/object-guards.js';
import { writeFileAtomic } from './atomic-write.js';
import { isPathSpec, isPluginControlSpec, parsePathSpec } from './plugin-spec.js';

export type PluginSwitchRead =
  | { ok: true; resources: string[] }
  | { ok: false; error: unknown };

export type PluginSwitchState = 'on' | 'off' | 'unavailable' | 'unreadable' | 'overridden';
export type PluginDenial = { action: 'integration.use'; resource: string; effect: 'deny' };

export interface PluginSwitchStore {
  filePath: string;
  read(): PluginSwitchRead;
  set(resource: string, enabled: boolean): { changed: boolean };
  denials(): PluginDenial[];
}

const PLUGIN_RESOURCE_PREFIX = 'plugin:';
const FILE_VERSION = 1;

const isPluginResource = (value: unknown): value is string =>
  isString(value) && value.startsWith(PLUGIN_RESOURCE_PREFIX) && value.length > PLUGIN_RESOURCE_PREFIX.length;

const fileUrlAbsolutePath = (spec: string) => {
  try {
    return fileURLToPath(spec);
  } catch {
    return null;
  }
};

const packagePolicyTarget = (spec: string) => {
  const version = spec.lastIndexOf('@');
  return version > 0 ? spec.slice(0, version) : spec;
};

export const pluginPolicyResource = (spec: string, sourcePath?: string) => {
  if (isPluginControlSpec(spec)) return null;
  if (/^file:/i.test(spec)) {
    if (!/^file:\/\//i.test(spec)) return null;
    const fileUrlPath = fileUrlAbsolutePath(spec);
    return fileUrlPath ? `plugin:${fileUrlPath}` : null;
  }
  const target = isPathSpec(spec)
    ? parsePathSpec(spec, {
      homedir: os.homedir(),
      cwd: sourcePath ? path.dirname(sourcePath) : process.cwd(),
    }).absolutePath
    : packagePolicyTarget(spec);
  return target ? `plugin:${target}` : null;
};

const matchesPolicyPattern = (target: string, pattern: string) => {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(target.replaceAll('\\', '/'));
};

const isPluginStatement = (statement: unknown): statement is { resource: string; action?: unknown; effect?: unknown } =>
  isRecord(statement) && isString(statement.resource);

const pluginStatementPattern = (statement: { resource: string; action?: unknown }) => {
  if (statement.action === 'plugin.use') return statement.resource;
  if (statement.action === 'integration.use' && statement.resource.startsWith(PLUGIN_RESOURCE_PREFIX)) {
    return statement.resource.slice(PLUGIN_RESOURCE_PREFIX.length);
  }
  return null;
};

export const isPluginDenialOverridden = (resource: string, configs: readonly unknown[]) => {
  const target = resource.slice(PLUGIN_RESOURCE_PREFIX.length);
  for (const config of configs) {
    const statements: unknown[] = isRecord(config) && Array.isArray(config.policies) ? config.policies : [];
    for (let index = statements.length - 1; index >= 0; index--) {
      const statement = statements[index];
      if (!isPluginStatement(statement)) continue;
      const pattern = pluginStatementPattern(statement);
      if (pattern !== null && matchesPolicyPattern(target, pattern)) return statement.effect === 'allow';
    }
  }
  return false;
};

export const pluginSwitchState = (read: PluginSwitchRead, resource: string, configsAhead: readonly unknown[]): PluginSwitchState => {
  if (!read.ok) return 'unreadable';
  if (isPluginDenialOverridden(resource, configsAhead)) return 'overridden';
  return read.resources.includes(resource) ? 'off' : 'on';
};

const hasErrorFields = (value: unknown): value is { message?: unknown; code?: unknown } => value != null;

export const createPluginSwitchStore = ({ filePath }: { filePath: string }): PluginSwitchStore => {
  const lastGoodPath = `${filePath}.last-good`;

  const parse = (text: string): PluginSwitchRead => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.disabled)) {
      return { ok: false, error: new Error('plugin switch state is not a list of plugin resources') };
    }
    const resources: unknown[] = parsed.disabled;
    if (!resources.every(isPluginResource)) {
      return { ok: false, error: new Error('plugin switch state contains a value that is not a plugin resource') };
    }
    return { ok: true, resources: Array.from(new Set(resources)) };
  };

  const read = (): PluginSwitchRead => {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (hasErrorFields(error) && error.code === 'ENOENT') return { ok: true, resources: [] };
      return { ok: false, error };
    }
    return parse(text);
  };

  const readLastGood = (): PluginSwitchRead => {
    try {
      return parse(fs.readFileSync(lastGoodPath, 'utf8'));
    } catch (error) {
      return { ok: false, error };
    }
  };

  const serialize = (resources: string[]) => `${JSON.stringify({ version: FILE_VERSION, disabled: Array.from(new Set(resources)).sort() }, null, 2)}\n`;

  const write = (resources: string[]) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, serialize(resources));
  };

  const set = (resource: string, enabled: boolean) => {
    if (!isPluginResource(resource)) {
      throw new Error(`Invalid plugin resource for a switch: ${resource}`);
    }
    const current = read();
    if (!current.ok) throw current.error;

    const disabled = new Set(current.resources);
    let changed = false;
    if (enabled) {
      changed = disabled.delete(resource);
    } else if (!disabled.has(resource)) {
      disabled.add(resource);
      changed = true;
    }

    if (changed) write(Array.from(disabled));
    return { changed };
  };

  const denials = (): PluginDenial[] => {
    let current = read();
    if (current.ok) {
      const text = serialize(current.resources);
      let saved = null;
      try {
        saved = fs.readFileSync(lastGoodPath, 'utf8');
      } catch {
        saved = null;
      }
      if (saved !== text) {
        try {
          fs.mkdirSync(path.dirname(lastGoodPath), { recursive: true });
          writeFileAtomic(lastGoodPath, text);
        } catch (error) {
          console.warn(`[plugins] Could not keep a copy of the plugin switches at ${lastGoodPath}: ${(hasErrorFields(error) ? error.message : undefined) ?? error}`);
        }
      }
    } else {
      const fallback = readLastGood();
      console.warn(`[plugins] Could not read the plugins switched off in ${filePath}; ${fallback.ok ? `keeping the last state read, ${fallback.resources.length} switched off` : 'no earlier state to keep'}: ${(hasErrorFields(current.error) ? current.error.message : undefined) ?? current.error}`);
      current = fallback.ok ? fallback : { ok: true, resources: [] };
    }
    return current.resources.map((resource) => ({ action: 'integration.use', resource, effect: 'deny' }));
  };

  return { filePath, read, set, denials };
};
