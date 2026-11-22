/**
 * Settings and configuration actions for the `openchamber` control tool:
 * OpenChamber's own settings, OpenCode's config files, reloading OpenCode,
 * and restarting the OpenChamber server.
 *
 * Dependencies (`createConfigActions(deps)`), with the identifier to pass from
 * packages/web/server/index.js:
 * - `readSettingsFromDiskMigrated` — `readSettingsFromDiskMigrated` (module scope).
 * - `formatSettingsResponse` — `formatSettingsResponse` (module scope); masks secrets.
 * - `sanitizeSettingsUpdate` — `sanitizeSettingsUpdate` (module scope); run
 *   first so a value OpenChamber would silently drop is refused instead.
 * - `persistSettings` — `persistSettings` (module scope).
 * - `refreshOpenCodeAfterConfigChange` — `refreshOpenCodeAfterConfigChange`
 *   (module scope); the same call `POST /api/config/reload` makes.
 * - `getRequestHandoff` — a getter returning `selfHandoffRuntime.requestHandoff`
 *   or null. `selfHandoffRuntime` is created inside `main()`, after the
 *   module-scope control service, so it is not in scope where the service is
 *   built: keep a module-scope `let requestSelfHandoff = null`, assign
 *   `selfHandoffRuntime.requestHandoff` to it in `main()` only when
 *   `attachSignals` is true (the process owns its lifetime; an embedding host
 *   that passed `attachSignals: false` must not be exited from inside), and
 *   pass `getRequestHandoff: () => requestSelfHandoff`. Absent or null makes
 *   `openchamber.restart` answer 501.
 * - Optional, for tests: `env` (process.env), `platform` (process.platform),
 *   `versions` (process.versions), `schedule` (setTimeout), `restartDelayMs`
 *   (750), `log` (console).
 *
 * OpenCode config files are read and written through ../opencode/shared.js
 * directly, the same JSONC-preserving helpers the config routes use.
 */
import { createRequire } from 'node:module';

import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import { readConfigLayers, getConfigForPath, writeConfig } from '../opencode/shared.js';
import { isPersistableSettingsKey } from '../opencode/settings-helpers.js';
import { SETTINGS_SURFACES } from '../opencode/settings-files.js';
import { isSelfHandoffEnabled } from '../opencode/self-handoff.js';
import { OpenChamberControlError } from './error.js';
import { isEnterpriseMode } from '../enterprise-mode.js';

const settingsRegistry = createRequire(import.meta.url)('../opencode/settings-registry.json');

export const CONFIG_ACTION_DEFINITIONS = Object.freeze([
  { action: 'settings.keys', title: 'List OpenChamber settings', description: 'List every OpenChamber setting key with its scope, whether it is kept per surface kind (perSurface), and whether settings.set may change it (and why not); no parameters' },
  { action: 'settings.devices', title: 'Read device-only settings', description: 'Read the settings each open OpenChamber window keeps for its own device, which settings.get does not show: theme choice, sidebar and panel widths and layout, message limit, scrollbars, dock badge, window controls, mobile keyboard. One entry per open window (tab) that reported since the server started, most recent first, with its surface kind and when it reported. Read only: the user changes these in that window' },
  { action: 'settings.get', title: 'Read OpenChamber settings', description: 'Read OpenChamber settings: all of them, or one settingKey. Some keys (perSurface in settings.keys, such as sidebarLayout, themeId or fontSize) hold a separate value for each surface kind: with surface, the values that surface uses are returned; without it, the base values plus a surfaces breakdown of each kind\'s own values. Secrets (passwords, tokens) are never returned, only whether they are set' },
  { action: 'settings.set', title: 'Change OpenChamber settings', description: 'Change OpenChamber settings: settingKey with settingValue (any JSON), or a settings object of several. A perSurface key changed with surface (web, desktop, vscode or mobile) changes only that surface kind; without surface it changes the base value, which a surface with its own value ignores. Every key is checked before anything is saved: unknown, device-only, computed, desktop-owned, secret and security-sensitive keys (permissions, tunnels, LAN access, the OpenCode binary, projects) are refused, as is a value OpenChamber would not accept. Turning off agentControlToolEnabled removes this tool and needs confirm. Open OpenChamber windows may need a reload to show the change' },
  { action: 'opencode.config.get', title: 'Read OpenCode config', description: 'Read OpenCode configuration and the files it comes from. configScope merged (default), user, project or custom; configPath is a dot path into it, such as mcp.servers.github or providers.openai.models["gpt-4.1"]. Values that look like keys, tokens or passwords are masked' },
  { action: 'opencode.config.set', title: 'Change OpenCode config', description: 'Set configValue (any JSON) at configPath in the user (default), project, or custom (the file OPENCODE_CONFIG names) OpenCode config file; configValue null or configDelete removes it. Comments and formatting in the file are kept. OpenCode applies the change on its own within seconds; the result says if another config file overrides it. Use only when the user asks for the change' },
  { action: 'opencode.reload', title: 'Restart OpenCode', description: 'Restart the OpenCode server OpenChamber manages so it re-reads its configuration; running sessions are handed over and keep going. Rarely needed, since OpenCode applies config file changes by itself: use it when the user asks or a change did not take. A connected external OpenCode cannot be restarted from here; the result says so' },
  { action: 'openchamber.restart', title: 'Restart OpenChamber', description: 'Restart the OpenChamber server itself, only when the user asks. It answers first, then starts a fresh server process on the same port and stops the old one once the new one serves; OpenCode and sessions keep running and open windows reconnect. If the new process fails to start, the old one keeps serving. Not available in the desktop app, on Windows, or when OpenChamber runs embedded or under Bun' },
]);

export const CONFIG_PARAMETERS = {
  settingKey: { type: 'string', description: 'OpenChamber setting key for settings.get or settings.set; settings.keys lists them' },
  settingValue: { description: 'New value for settingKey in settings.set; any JSON value' },
  settings: { type: 'object', description: 'settings.set: several settings at once, key to value' },
  surface: { type: 'string', enum: SETTINGS_SURFACES, description: 'settings.get and settings.set: the surface kind whose own values to read or change for perSurface keys; omit for the base values' },
  configScope: { type: 'string', enum: ['merged', 'user', 'project', 'custom'], description: 'Which OpenCode config file. opencode.config.get reads merged (default), user, project or custom. opencode.config.set writes user (default), project or custom. mcp.toggle, skills.toggle, tools.toggle, models.toggle, models.default, provider.models.add/remove and models.cost write user (default) or project (the project config of directory or projectId)' },
  configPath: { type: 'string', description: 'Dot path into the OpenCode config, such as model or mcp.servers.github.disabled; quote a key containing dots as ["gpt-4.1"]' },
  configValue: { description: 'Value for opencode.config.set; any JSON value, null removes the key' },
  configDelete: { type: 'boolean', description: 'opencode.config.set: remove configPath instead of setting it' },
  confirm: { type: 'boolean', description: 'Confirms an action that turns off the openchamber tool itself, signs the user out of a connected service (github.remove, gitlab.remove, linear.disconnect, extensions.disconnect), or changes which credentials Git uses (binding.set); set only when the user explicitly asked for that' },
};

const CONFIG_ACTIONS = CONFIG_ACTION_DEFINITIONS.map(({ action }) => action);

const SECRET_KEYS = new Set(
  Object.entries(settingsRegistry.fields).filter(([, field]) => field.secret === true).map(([key]) => key),
);

/**
 * Keys an agent may not change even though the settings route accepts them
 * from the user: each one widens what the agent can do or who can reach the
 * machine, or has a dedicated action that validates it properly.
 */
const AGENT_BLOCKED_SETTINGS = Object.freeze({
  permissionAutoAccept: 'it approves permissions; an agent may not widen its own permissions',
  permissionDefaultMode: 'it approves permissions; an agent may not widen its own permissions',
  opencodeBinary: 'it chooses which executable runs as OpenCode',
  desktopLanAccessEnabled: 'it exposes OpenChamber to the network',
  tunnelProvider: 'it exposes OpenChamber to the network',
  tunnelMode: 'it exposes OpenChamber to the network',
  tunnelBootstrapTtlMs: 'it exposes OpenChamber to the network',
  tunnelSessionTtlMs: 'it exposes OpenChamber to the network',
  managedLocalTunnelConfigPath: 'it exposes OpenChamber to the network',
  managedRemoteTunnelHostname: 'it exposes OpenChamber to the network',
  managedRemoteTunnelPresets: 'it exposes OpenChamber to the network',
  managedRemoteTunnelSelectedPresetId: 'it exposes OpenChamber to the network',
  githubClientId: 'it configures sign-in credentials',
  githubScopes: 'it configures sign-in credentials',
  gitlabClientId: 'it configures sign-in credentials',
  securityScopedBookmarks: 'it holds macOS file-access grants',
  projects: 'use projects.add, projects.update or projects.remove',
  activeProjectId: 'the user picks the active project',
});

/** Why settings.set refuses a key, or null when it may be changed. */
const settingRefusal = (key) => {
  const field = settingsRegistry.fields[key];
  if (!field) return 'not an OpenChamber setting (settings.keys lists them)';
  if (field.secret === true) return 'it is a secret; the user sets it in Settings';
  if (field.computed) return 'it is computed by the server';
  if (field.local || field.scope === 'device') return 'it is stored per device in the browser, not on the server';
  if (field.owner === 'desktop-shell') return 'the desktop app manages it';
  if (!isPersistableSettingsKey(key)) return 'it cannot be saved through settings';
  if (Object.hasOwn(AGENT_BLOCKED_SETTINGS, key)) return AGENT_BLOCKED_SETTINGS[key];
  return null;
};

const settingMetadata = (key) => {
  const refusal = settingRefusal(key);
  const metadata = { scope: settingsRegistry.fields[key]?.scope ?? null, editable: refusal === null };
  if (settingsRegistry.fields[key]?.perSurface === true) metadata.perSurface = true;
  if (refusal) metadata.reason = refusal;
  return metadata;
};

const PER_SURFACE_KEYS = Object.entries(settingsRegistry.fields)
  .filter(([, field]) => field.perSurface === true && field.secret !== true)
  .map(([key]) => key);

const resolveSurface = (input) => {
  if (input.surface === undefined || input.surface === null) return null;
  if (!SETTINGS_SURFACES.includes(input.surface)) {
    throw new OpenChamberControlError(`surface must be ${SETTINGS_SURFACES.join(', ')}`, 400);
  }
  return input.surface;
};

const CONTROL_TOOL_SETTING_KEY = 'agentControlToolEnabled';

// ---------------------------------------------------------------------------
// Config paths

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PATH_SEGMENTS = 32;

/**
 * `a.b["c.d"][0]` → ['a', 'b', 'c.d', 0]. Bracketed numbers index arrays
 * (reads only); a quoted bracket is a key that may contain dots.
 */
export const parseConfigPath = (raw) => {
  const text = asNonEmptyString(raw) ?? '';
  if (!text) return [];
  const segments = [];
  let index = 0;
  const fail = (reason) => {
    throw new OpenChamberControlError(`configPath ${JSON.stringify(text)} is not valid: ${reason}`, 400);
  };
  while (index < text.length) {
    if (text[index] === '[') {
      const quote = text[index + 1];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(`${quote}]`, index + 2);
        if (close === -1) fail('unclosed quoted key');
        const key = text.slice(index + 2, close);
        if (!key) fail('empty quoted key');
        segments.push(key);
        index = close + 2;
      } else {
        const close = text.indexOf(']', index);
        if (close === -1) fail('unclosed [');
        const inner = text.slice(index + 1, close).trim();
        if (!/^\d+$/.test(inner)) fail('brackets hold an array index or a quoted key');
        segments.push(Number(inner));
        index = close + 1;
      }
    } else {
      let end = index;
      while (end < text.length && text[end] !== '.' && text[end] !== '[') end += 1;
      const segment = text.slice(index, end).trim();
      if (!segment) fail('empty segment');
      if (segment.includes(']')) fail('unexpected ]');
      segments.push(segment);
      index = end;
    }
    if (index < text.length) {
      if (text[index] === '.') {
        index += 1;
        if (index >= text.length) fail('ends with a dot');
      } else if (text[index] !== '[') {
        fail(`unexpected ${JSON.stringify(text[index])}`);
      }
    }
  }
  if (segments.length > MAX_PATH_SEGMENTS) fail(`more than ${MAX_PATH_SEGMENTS} segments`);
  for (const segment of segments) {
    if (!Number.isInteger(segment) && FORBIDDEN_SEGMENTS.has(segment)) fail(`segment ${JSON.stringify(segment)} is not allowed`);
  }
  return segments;
};

const readAtPath = (root, segments) => {
  let current = root;
  for (const segment of segments) {
    if (Number.isInteger(segment) ? !Array.isArray(current) : !isPlainObject(current)) return { found: false };
    if (!Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
};

const SECRET_KEY_PATTERN = /(api[-_]?key|apikey|token|secret|password|passwd|passphrase|authorization|credential|cookie)/i;
// The secret words above are shared with integration-service-actions.js's
// SECRET_KEY. Token, secret, password, passwd, passphrase, api-key, cookie
// and authorization are secrets on both sides, so a widening here must be
// mirrored there and the other way round. One intentional divergence: this
// pattern also masks `credential`. The integration guard leaves
// credential-named binding fields readable because they name a stored
// account, a reference to it, and hold no secret value themselves.
// The bare-key rule, shared with integration-service-actions.js: a name that
// ends in `key` or `keys` (privateKey, accessKeys, a key literally named
// `key`) holds a secret. Suffix-only, so keybinds and other names that merely
// start with or contain `key` stay readable. A name like `monkey` also ends
// in `key` and stays masked. That is the deliberate fail-closed reading, and
// a test pins it.
const SECRET_KEY_SUFFIX = /keys?$/i;
const isSecretKeyName = (key) => SECRET_KEY_PATTERN.test(key) || SECRET_KEY_SUFFIX.test(key);
// `{env:NAME}` and `{file:path}` are references, not the secret itself.
const isConfigReference = (value) => /^\{(env|file):[^}]+\}$/.test(value.trim());

/**
 * Copy of a config value with secret-looking string values masked. A
 * secret-named key masks every string leaf under it, through nested plain
 * objects and arrays of objects, so structured key material (a JWK object,
 * a `{value: ...}` wrapper) stays hidden. Reference leaves keep their
 * readable form at any depth.
 */
export const maskConfigSecrets = (value, key = '', secretAncestor = false) => {
  const secret = secretAncestor || isSecretKeyName(key);
  if (Array.isArray(value)) return value.map((entry) => maskConfigSecrets(entry, key, secret));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, maskConfigSecrets(entry, entryKey, secret)]));
  }
  if (isString(value) && value && secret && !isConfigReference(value)) return '********';
  return value;
};

const isInvalidJsonc = (error) => error?.code === 'INVALID_JSONC';

const asConfigFileError = (error) => (isInvalidJsonc(error)
  ? new OpenChamberControlError(`${error.message}. Fix the file by hand before changing it here`, 409)
  : error);

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ---------------------------------------------------------------------------

export const createConfigActions = (deps) => {
  const {
    readSettingsFromDiskMigrated,
    formatSettingsResponse,
    sanitizeSettingsUpdate,
    persistSettings,
    refreshOpenCodeAfterConfigChange = null,
    getRequestHandoff = () => null,
    // The device settings windows reported (../device-settings/store.js).
    listDeviceSettings = null,
    env = process.env,
    platform = process.platform,
    versions = process.versions,
    schedule = (callback, delay) => setTimeout(callback, delay),
    restartDelayMs = 750,
    log = console,
  } = deps;

  let restartScheduled = false;

  const resolveDirectory = (input, ctx) => asNonEmptyString(input.directory) || asNonEmptyString(ctx?.contextDirectory) || null;

  const settingsKeys = () => ({
    keys: Object.entries(settingsRegistry.fields).map(([key, field]) => {
      const entry = { key, ...settingMetadata(key) };
      if (field.secret) entry.secret = true;
      return entry;
    }),
  });

  // Each surface kind's own values for the perSurface keys: a surface read
  // resolves its own value first and the base otherwise, so a value that
  // differs from the base is that surface's own.
  const surfaceValues = async (base, keys) => {
    const result = {};
    for (const surface of SETTINGS_SURFACES) {
      const resolved = formatSettingsResponse(await readSettingsFromDiskMigrated({ surface }));
      for (const key of keys) {
        if (!Object.hasOwn(resolved, key) || jsonEqual(resolved[key], base[key])) continue;
        (result[surface] ??= {})[key] = resolved[key];
      }
    }
    return result;
  };

  const settingsDevices = () => {
    if (!listDeviceSettings) throw new OpenChamberControlError('Device settings are not available on this server', 503);
    const devices = listDeviceSettings();
    return {
      devices,
      note: devices.length === 0
        ? 'No window has reported since the server started; open OpenChamber in a browser, the desktop app or the phone app'
        : 'Each open window reports its own; a device whose windows are closed keeps its last report until the server restarts',
    };
  };

  const settingsGet = async (input) => {
    const surface = resolveSurface(input);
    const stored = await (surface ? readSettingsFromDiskMigrated({ surface }) : readSettingsFromDiskMigrated());
    const formatted = formatSettingsResponse(stored);
    const key = asNonEmptyString(input.settingKey);
    if (!key) {
      const result = { settings: formatted, note: 'Secrets are left out; settings.keys lists every key and whether it can be changed' };
      if (surface) {
        result.surface = surface;
      } else {
        const surfaces = await surfaceValues(formatted, PER_SURFACE_KEYS);
        if (Object.keys(surfaces).length > 0) {
          result.surfaces = surfaces;
          result.note += '. settings holds the base values; surfaces holds the values a surface kind uses instead';
        }
      }
      return result;
    }
    const field = settingsRegistry.fields[key];
    if (!field) throw new OpenChamberControlError(`Unknown setting: ${key}. settings.keys lists them`, 404);
    const metadata = settingMetadata(key);
    if (SECRET_KEYS.has(key)) {
      const raw = stored?.[key];
      const isSet = isString(raw) ? raw.trim().length > 0 : (isPlainObject(raw) ? Object.keys(raw).length > 0 : Boolean(raw));
      return { key, secret: true, isSet, ...metadata };
    }
    const present = Object.hasOwn(formatted, key);
    const result = { key, value: present ? formatted[key] : null, present, ...metadata };
    if (surface) {
      result.surface = surface;
    } else if (field.perSurface === true) {
      const surfaces = Object.fromEntries(
        Object.entries(await surfaceValues(formatted, [key])).map(([kind, values]) => [kind, values[key]]),
      );
      if (Object.keys(surfaces).length > 0) result.surfaces = surfaces;
    }
    return result;
  };

  const settingsSet = async (input) => {
    const surface = resolveSurface(input);
    const single = asNonEmptyString(input.settingKey);
    const hasMany = input.settings !== undefined;
    if (single && hasMany) throw new OpenChamberControlError('Provide settingKey with settingValue, or settings, not both', 400);
    let changes;
    if (single) {
      if (input.settingValue === undefined) throw new OpenChamberControlError('settingValue is required with settingKey', 400);
      changes = { [single]: input.settingValue };
    } else if (hasMany) {
      if (!isPlainObject(input.settings)) throw new OpenChamberControlError('settings must be an object of key to value', 400);
      changes = input.settings;
    } else {
      throw new OpenChamberControlError('settingKey with settingValue, or settings, is required', 400);
    }
    const keys = Object.keys(changes);
    if (keys.length === 0) throw new OpenChamberControlError('settings is empty', 400);

    const refusals = keys.map((key) => [key, settingRefusal(key)]).filter(([, reason]) => reason);
    if (refusals.length > 0) {
      throw new OpenChamberControlError(`Nothing was saved. ${refusals.map(([key, reason]) => `${key}: ${reason}`).join('; ')}`, 400);
    }
    if (changes[CONTROL_TOOL_SETTING_KEY] === false && input.confirm !== true) {
      throw new OpenChamberControlError(`Nothing was saved. Turning off ${CONTROL_TOOL_SETTING_KEY} removes the openchamber tool, including this action; repeat with confirm true only if the user explicitly asked for it`, 400);
    }

    // persistSettings sanitizes too, but drops a bad value silently; checking
    // first turns that into an answer the agent can correct.
    const sanitized = sanitizeSettingsUpdate(changes);
    const dropped = keys.filter((key) => !Object.hasOwn(sanitized, key));
    if (dropped.length > 0) {
      throw new OpenChamberControlError(`Nothing was saved. OpenChamber does not accept the value given for ${dropped.join(', ')}; check its type and allowed values with settings.get`, 400);
    }

    const saved = await (surface ? persistSettings(sanitized, { surface }) : persistSettings(sanitized));
    const updated = Object.fromEntries(keys.map((key) => [key, Object.hasOwn(saved ?? {}, key) ? saved[key] : null]));
    const result = {
      updated,
      note: 'Saved. Open OpenChamber windows may need a reload to show the change; OpenChamber tool switches reach OpenCode within a few seconds',
    };
    if (surface) {
      result.surface = surface;
      const shared = keys.filter((key) => settingsRegistry.fields[key]?.perSurface !== true);
      if (shared.length > 0) {
        result.note += `. ${shared.join(', ')} ${shared.length === 1 ? 'is' : 'are'} not kept per surface kind, so every surface uses the new value`;
      }
    }
    const baseOnly = surface ? [] : keys.filter((key) => settingsRegistry.fields[key]?.perSurface === true);
    if (baseOnly.length > 0) {
      result.note += `. ${baseOnly.join(', ')} ${baseOnly.length === 1 ? 'is' : 'are'} kept per surface kind and this changed the base value; a surface with its own value keeps it (settings.get shows them; pass surface to change one)`;
    }
    return result;
  };

  const resolveScope = (input, { allowRead }) => {
    const scope = asNonEmptyString(input.configScope) || (allowRead ? 'merged' : 'user');
    const allowed = allowRead ? ['merged', 'user', 'project', 'custom'] : ['user', 'project', 'custom'];
    if (!allowed.includes(scope)) {
      throw new OpenChamberControlError(`configScope must be ${allowed.join(', ')}${allowRead ? '' : '; merged is a view of several files, not one to write'}`, 400);
    }
    return scope;
  };

  const configGet = (input, ctx) => {
    const scope = resolveScope(input, { allowRead: true });
    const directory = resolveDirectory(input, ctx);
    if (scope === 'project' && !directory) throw new OpenChamberControlError('directory is required for the project config', 400);
    const segments = parseConfigPath(input.configPath);
    const layers = readConfigLayers(directory);
    const source = {
      merged: layers.mergedConfig,
      user: layers.userConfig,
      project: layers.projectConfig,
      custom: layers.customConfig,
    }[scope];
    const { found, value } = readAtPath(source, segments);
    const result = {
      scope,
      configPath: segments.length > 0 ? input.configPath.trim() : null,
      found,
      value: found ? maskConfigSecrets(value, Number.isInteger(segments.at(-1)) ? '' : segments.at(-1)) : null,
      files: {
        user: layers.paths.userPath,
        userOverride: layers.paths.userOverridePath,
        project: layers.paths.projectPath,
        custom: layers.paths.customPath,
      },
      note: 'merged folds the files OpenChamber reads (user, project, custom); OpenCode may also load plugin and organization config',
    };
    if (layers.layerErrors.length > 0) {
      result.layerErrors = layers.layerErrors.map(({ path: file, message }) => ({ path: file, message }));
    }
    return result;
  };

  const configSet = (input, ctx) => {
    // A config write can add a provider or a destination for conversation
    // content (share, a remote MCP server, a messaging endpoint), which
    // enterprise mode refuses. Fail closed: no agent config writes there.
    if (isEnterpriseMode()) {
      throw new OpenChamberControlError('Changing OpenCode configuration from the agent tool is not available in enterprise mode', 403, { code: 'enterprise_mode' });
    }
    const scope = resolveScope(input, { allowRead: false });
    const directory = resolveDirectory(input, ctx);
    if (scope === 'project' && !directory) throw new OpenChamberControlError('directory is required for the project config', 400);
    const segments = parseConfigPath(input.configPath);
    if (segments.length === 0) throw new OpenChamberControlError('configPath is required', 400);
    if (segments.some((segment) => Number.isInteger(segment))) {
      throw new OpenChamberControlError('configPath may not index into an array; set the whole array instead', 400);
    }
    const remove = input.configDelete === true || input.configValue === null;
    if (!remove && input.configValue === undefined) {
      throw new OpenChamberControlError('configValue is required; use configDelete or null to remove the key', 400);
    }
    if (input.configDelete === true && input.configValue !== undefined && input.configValue !== null) {
      throw new OpenChamberControlError('configDelete cannot be combined with a configValue', 400);
    }

    const layers = readConfigLayers(directory);
    // custom is the file the user's own OPENCODE_CONFIG names, the same file
    // Settings writes when it is set; OpenChamber's managed config file is set
    // only in OpenCode's environment and never reaches this one.
    if (scope === 'custom' && !layers.paths.customPath) {
      throw new OpenChamberControlError('There is no custom config file: OPENCODE_CONFIG is not set for OpenChamber. Use user or project', 400);
    }
    const targetPath = { project: layers.paths.projectPath, custom: layers.paths.customPath }[scope] ?? layers.paths.userPath;
    const layerError = layers.layerErrors.find((entry) => entry.path === targetPath);
    if (layerError) throw new OpenChamberControlError(`${layerError.message}. Fix the file by hand before changing it here`, 409);

    const next = structuredClone(getConfigForPath(layers, targetPath) ?? {});
    const parentSegments = segments.slice(0, -1);
    const leaf = segments.at(-1);
    let parent = next;
    for (const [position, segment] of parentSegments.entries()) {
      if (!Object.hasOwn(parent, segment)) {
        if (remove) return { scope, file: targetPath, configPath: input.configPath.trim(), deleted: false, note: 'The key was not in this file; nothing changed' };
        parent[segment] = {};
      } else if (!isPlainObject(parent[segment])) {
        throw new OpenChamberControlError(`configPath crosses a non-object at ${JSON.stringify(segments.slice(0, position + 1).join('.'))}; set that key instead`, 400);
      }
      parent = parent[segment];
    }
    if (remove && !Object.hasOwn(parent, leaf)) {
      return { scope, file: targetPath, configPath: input.configPath.trim(), deleted: false, note: 'The key was not in this file; nothing changed' };
    }
    if (remove) delete parent[leaf];
    else parent[leaf] = input.configValue;

    try {
      writeConfig(next, targetPath);
    } catch (error) {
      throw asConfigFileError(error);
    }

    const after = readAtPath(readConfigLayers(directory).mergedConfig, segments);
    const shadowed = remove ? after.found : !after.found || !jsonEqual(after.value, input.configValue);
    return {
      scope,
      file: targetPath,
      configPath: input.configPath.trim(),
      ...(remove ? { deleted: true } : { value: maskConfigSecrets(input.configValue, leaf) }),
      effectiveValue: after.found ? maskConfigSecrets(after.value, leaf) : null,
      shadowed,
      note: shadowed
        ? 'Saved, but another config file sets this path too and wins; opencode.config.get with configScope project or custom shows it'
        : 'Saved. OpenCode watches its config files and applies this within seconds; opencode.reload restarts it if a change does not take',
    };
  };

  const opencodeReload = async () => {
    if (!refreshOpenCodeAfterConfigChange) {
      throw new OpenChamberControlError('Restarting OpenCode is not available on this server', 503);
    }
    const result = await refreshOpenCodeAfterConfigChange('agent configuration reload');
    if (result?.external) {
      return {
        reloaded: false,
        external: true,
        message: 'OpenChamber is connected to an external OpenCode server it does not own. The configuration is on disk; the user has to restart that server to apply it',
      };
    }
    return { reloaded: true, message: 'OpenCode restarted with its current configuration; running sessions were handed over' };
  };

  const restartUnavailable = () => {
    if (env.OPENCHAMBER_RUNTIME === 'desktop') return 'The desktop app owns this server; quit and reopen OpenChamber to restart it';
    if (platform === 'win32') return 'Restarting in place needs POSIX signals and file-descriptor passing, which Windows does not have; restart OpenChamber by hand';
    if (!isSelfHandoffEnabled(env)) return 'In-place restart is turned off here (OPENCHAMBER_SELF_HANDOFF=0); restart OpenChamber with `openchamber restart`';
    if (versions?.bun) return 'This server runs under Bun, which does not expose its listening socket to a successor; restart OpenChamber with `openchamber restart`';
    if (!getRequestHandoff()) return 'This server runs embedded in another process and cannot restart itself; restart its host';
    return null;
  };

  const openchamberRestart = () => {
    const unavailable = restartUnavailable();
    if (unavailable) throw new OpenChamberControlError(unavailable, 501);
    if (restartScheduled) {
      return { scheduled: true, alreadyScheduled: true, message: 'A restart is already on its way' };
    }
    restartScheduled = true;
    const requestHandoff = getRequestHandoff();
    // Answer first: the old process stops accepting once the successor
    // serves, and this reply has to be on its way before that.
    schedule(() => {
      Promise.resolve()
        .then(() => requestHandoff({ exitProcess: true }))
        .then((outcome) => {
          if (!outcome?.ok) log.warn?.(`[openchamber.restart] not restarted (${outcome?.reason ?? 'unknown'}); still serving`);
        })
        .catch((error) => log.warn?.(`[openchamber.restart] failed: ${error?.message ?? error}; still serving`))
        .finally(() => { restartScheduled = false; });
    }, restartDelayMs);
    return {
      scheduled: true,
      delayMs: restartDelayMs,
      message: 'OpenChamber restarts in a moment: a new server process takes over the same port and this one exits once it serves (up to about 30 seconds). OpenCode and sessions keep running. If the new process fails, this one keeps serving and logs why. The next tool call may fail while it switches over; retry it',
    };
  };

  const execute = async (action, input = {}, ctx = {}) => {
    try {
      switch (action) {
        case 'settings.keys': return settingsKeys();
        case 'settings.devices': return settingsDevices();
        case 'settings.get': return await settingsGet(input);
        case 'settings.set': return await settingsSet(input);
        case 'opencode.config.get': return configGet(input, ctx);
        case 'opencode.config.set': return configSet(input, ctx);
        case 'opencode.reload': return await opencodeReload();
        case 'openchamber.restart': return openchamberRestart();
        default: throw new OpenChamberControlError(`Unsupported config action: ${action || 'missing'}`, 400);
      }
    } catch (error) {
      throw asConfigFileError(error);
    }
  };

  return { actions: CONFIG_ACTIONS, execute };
};
