import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord, isString } from '../shared/guards.js';
import { writeFileAtomic } from './atomic-write.js';
import { isPathSpec, isPluginControlSpec, parsePathSpec } from './plugin-spec.js';

const PLUGIN_RESOURCE_PREFIX = 'plugin:';
const FILE_VERSION = 1;

const isPluginResource = (value) => isString(value) && value.startsWith(PLUGIN_RESOURCE_PREFIX) && value.length > PLUGIN_RESOURCE_PREFIX.length;

/** The absolute path a `file://` URL names, or null when the URL is unusable. */
const fileUrlAbsolutePath = (spec) => {
  try {
    return fileURLToPath(spec);
  } catch {
    return null;
  }
};

/**
 * The target OpenCode's `PluginModule.load` checks for a package or Git spec:
 * everything before the last `@`, whatever that `@` means in the spec. Parsing
 * the spec as an npm name would deny a resource OpenCode never compares for a
 * Git spec with more than one `@`.
 */
const packagePolicyTarget = (spec) => {
  const version = spec.lastIndexOf('@');
  return version > 0 ? spec.slice(0, version) : spec;
};

/**
 * The `plugin:` resource OpenCode matches for an entry: a package or Git spec
 * without its version (`leakshield`, `@acme/plugin`) or the absolute path of a
 * local plugin. A relative path resolves against the config file that declares the entry.
 * Null when the spec is neither, which leaves the entry without a switch.
 *
 * @param {string} spec
 * @param {string} [sourcePath] the config file that declares the entry
 * @returns {string | null}
 */
export const pluginPolicyResource = (spec, sourcePath) => {
  // A control entry (`-name`, `*`, `name.*`, `opencode.<name>`) changes the
  // plugin list itself; it is not a plugin OpenCode loads, so it has no switch.
  if (isPluginControlSpec(spec)) return null;
  // OpenCode recognizes `file://` specs and drops the plugin by the path the
  // URL names. Any other `file:` spelling names no file OpenCode matches, so it
  // gets no switch; falling through to npm parsing would write a deny for a
  // resource nothing compares.
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

/** OpenCode's `Wildcard.match`: `*` is any run, `?` one character, a trailing ` *` also matches nothing. */
const matchesPolicyPattern = (target, pattern) => {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(target.replaceAll('\\', '/'));
};

/** The plugin pattern of a config statement, in either spelling OpenCode accepts; null for any other statement. */
const pluginStatementPattern = (statement) => {
  if (!isRecord(statement) || !isString(statement.resource)) return null;
  if (statement.action === 'plugin.use') return statement.resource;
  if (statement.action === 'integration.use' && statement.resource.startsWith(PLUGIN_RESOURCE_PREFIX)) {
    return statement.resource.slice(PLUGIN_RESOURCE_PREFIX.length);
  }
  return null;
};

/**
 * Whether a config loaded ahead of the switch denials allows this plugin, which
 * makes the denial do nothing. OpenCode decides by the earliest-loaded config
 * with a matching statement, and by the last match inside that config. System
 * and Console policies never reach these files; the page catches those through
 * what OpenCode reports (`components/sections/DOCUMENTATION.md`).
 *
 * @param {string} resource a `plugin:` resource
 * @param {readonly unknown[]} configs earliest-loaded first
 * @returns {boolean}
 */
export const isPluginDenialOverridden = (resource, configs) => {
  const target = resource.slice(PLUGIN_RESOURCE_PREFIX.length);
  for (const config of configs) {
    const statements = isRecord(config) && Array.isArray(config.policies) ? config.policies : [];
    const deciding = statements.findLast((statement) => {
      const pattern = pluginStatementPattern(statement);
      return pattern !== null && matchesPolicyPattern(target, pattern);
    });
    if (deciding) return deciding.effect === 'allow';
  }
  return false;
};

/**
 * What a plugin row reports. `unreadable` when OpenChamber cannot read its own
 * state; `overridden` when a denial would do nothing here.
 *
 * @param {{ ok: true, resources: string[] } | { ok: false, error: Error }} read
 * @param {string} resource
 * @param {readonly unknown[]} configsAhead the configs loaded ahead of the denials
 * @returns {'on' | 'off' | 'unreadable' | 'overridden'}
 */
export const pluginSwitchState = (read, resource, configsAhead) => {
  if (!read.ok) return 'unreadable';
  if (isPluginDenialOverridden(resource, configsAhead)) return 'overridden';
  return read.resources.includes(resource) ? 'off' : 'on';
};

/**
 * The plugins switched off in OpenChamber, as `plugin:` resources.
 *
 * The switch is OpenChamber's, not OpenCode's: the entries stay in the user's
 * config, and the managed OpenCode OpenChamber starts reads these denials from
 * its own config layer (`opencode.managed.json`). The user's own `opencode`
 * process never reads this file.
 *
 * The file is small and read on every plugin listing; it is written atomically
 * because a partial read would turn every switched-off plugin back on for the
 * managed child until the next write.
 *
 * @param {{ filePath: string }} input
 */
export const createPluginSwitchStore = ({ filePath }) => {
  /**
   * @returns {{ ok: true, resources: string[] } | { ok: false, error: Error }}
   */
  // The last state read whole, kept beside the store: what a broken store
  // falls back to, across restarts too.
  const lastGoodPath = `${filePath}.last-good`;

  const parse = (text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.disabled)) {
      return { ok: false, error: new Error('plugin switch state is not a list of plugin resources') };
    }
    if (parsed.disabled.some((value) => !isPluginResource(value))) {
      return { ok: false, error: new Error('plugin switch state contains a value that is not a plugin resource') };
    }
    return { ok: true, resources: Array.from(new Set(parsed.disabled)) };
  };

  const read = () => {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, resources: [] };
      return { ok: false, error };
    }
    return parse(text);
  };

  const readLastGood = () => {
    try {
      return parse(fs.readFileSync(lastGoodPath, 'utf8'));
    } catch (error) {
      return { ok: false, error };
    }
  };

  const serialize = (resources) => `${JSON.stringify({ version: FILE_VERSION, disabled: Array.from(new Set(resources)).sort() }, null, 2)}\n`;

  const write = (resources) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, serialize(resources));
  };

  /**
   * Persist one switch. An unreadable file fails the change instead of
   * overwriting state OpenChamber cannot account for.
   */
  const set = (resource, enabled) => {
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

  /**
   * The denials for the managed config layer. Each whole read is copied beside
   * the store; an unreadable store falls back to that copy, so a broken file
   * neither stops OpenCode from starting nor turns switched-off plugins back
   * on, and the page reports the store as unreadable until it is fixed.
   */
  const denials = () => {
    let current = read();
    if (current.ok) {
      const text = serialize(current.resources);
      let saved = null;
      try {
        saved = fs.readFileSync(lastGoodPath, 'utf8');
      } catch {
        // No copy yet.
      }
      if (saved !== text) {
        try {
          fs.mkdirSync(path.dirname(lastGoodPath), { recursive: true });
          writeFileAtomic(lastGoodPath, text);
        } catch (error) {
          console.warn(`[plugins] Could not keep a copy of the plugin switches at ${lastGoodPath}: ${error?.message ?? error}`);
        }
      }
    } else {
      const fallback = readLastGood();
      console.warn(`[plugins] Could not read the plugins switched off in ${filePath}; ${fallback.ok ? `keeping the last state read, ${fallback.resources.length} switched off` : 'no earlier state to keep'}: ${current.error?.message ?? current.error}`);
      current = fallback.ok ? fallback : { ok: true, resources: [] };
    }
    return current.resources.map((resource) => ({ action: 'integration.use', resource, effect: 'deny' }));
  };

  return { filePath, read, set, denials };
};
