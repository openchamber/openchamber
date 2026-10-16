/**
 * Per-skill on/off through OpenCode's own policy config (#3075).
 *
 * A skill is switched off with one statement in an OpenCode config file:
 *
 *   { "action": "integration.use", "resource": "skill:<id>", "effect": "deny" }
 *
 * OpenCode then drops the skill from its registry, from the model's list and
 * from explicit `session.skill` / prompt attachments, without a restart. The
 * id is OpenCode's path-derived skill id (the folder of `SKILL.md`), never the
 * display name, and one id covers every source copy of a skill.
 *
 * Where the statement goes depends on the running OpenCode: 2.0.25 through
 * 2.0.28 read only `experimental.policies`, 2.0.29 and newer also read the
 * top-level `policies` (and mark the experimental key deprecated).
 *
 * Ownership: the statement a switch writes carries one more key,
 * `"openchamber": "skill-switch"`, and a switch only ever removes statements
 * with that key. OpenCode 2.0.25, 2.0.28, 2.0.29 and 2.0.30 accept the extra key without a
 * diagnostic, still enforce the statement, and leave the key out of
 * `GET /api/config` (verified for #3075 on isolated servers). The switch
 * writes in the one config file of the scope it edits (the user's global
 * `opencode.json[c]` or the project config OpenChamber writes for the
 * directory). Turning a skill off adds the marked deny unless a deny already
 * decides the skill in that file; turning it on removes the marked denies for
 * that id and nothing else. A user's own exact deny, wildcards, allows, other
 * actions, other files and Console policies are never written or removed, so
 * a restriction the switch did not create stays in force and is reported
 * through `decidedBy` instead of being overridden with an allow.
 *
 * This module is pure apart from the injected file and OpenCode readers, so
 * the web server and the VS Code extension host share one implementation.
 */
import fs from 'fs';
import path from 'path';
import { isBoolean, isPlainObject, isString } from '../shared/guards.js';

/** Scopes a switch can write. */
const SKILL_POLICY_SCOPES = Object.freeze(['global', 'project']);

const INTEGRATION_USE = 'integration.use';
const SKILL_RESOURCE_PREFIX = 'skill:';

/** The config key OpenCode reads policy statements from, by version. */
const SKILL_POLICY_LOCATION = Object.freeze({
  EXPERIMENTAL: 'experimental.policies',
  TOP_LEVEL: 'policies',
});

const EXPERIMENTAL_PATH = ['experimental', 'policies'];
const TOP_LEVEL_PATH = ['policies'];

const releaseParts = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(isString(version) ? version.trim() : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const isAtLeast = (parts, minimum) => {
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
};

/**
 * Where a running OpenCode reads skill policies: `policies` from 2.0.29,
 * `experimental.policies` from 2.0.25, `null` for anything that does not
 * enforce them (older 2.x, another major, an unreadable version).
 */
export function skillPolicyLocation(version) {
  const parts = releaseParts(version);
  if (!parts || parts[0] !== 2) return null;
  if (isAtLeast(parts, [2, 0, 29])) return SKILL_POLICY_LOCATION.TOP_LEVEL;
  if (isAtLeast(parts, [2, 0, 25])) return SKILL_POLICY_LOCATION.EXPERIMENTAL;
  return null;
}

/** The arrays a version enforces, in the order OpenCode concatenates them. */
const enforcedPaths = (location) => (location === SKILL_POLICY_LOCATION.EXPERIMENTAL
  ? [EXPERIMENTAL_PATH]
  : [EXPERIMENTAL_PATH, TOP_LEVEL_PATH]);

const writePath = (location) => (location === SKILL_POLICY_LOCATION.EXPERIMENTAL ? EXPERIMENTAL_PATH : TOP_LEVEL_PATH);

/**
 * A skill id a switch may name: what OpenCode derives from a folder or file
 * name. Wildcard characters and separators are refused, so an owned statement
 * can only ever match the one id it was written for.
 */
const FORBIDDEN_ID_CHARACTERS = new Set(['*', '?', '/', '\\']);

export function isValidSkillPolicyId(id) {
  return isString(id)
    && id.length > 0
    && id.length <= 255
    && id === id.trim()
    && id !== '.'
    && id !== '..'
    && ![...id].some((character) => {
      const code = character.charCodeAt(0);
      return FORBIDDEN_ID_CHARACTERS.has(character) || code < 0x20 || code === 0x7f;
    });
}

/**
 * OpenCode's skill id for a skill file: the folder of a `SKILL.md`, or the
 * name of a loose `<id>.md` file. `null` for anything else.
 */
export function skillIdFromPath(skillPath) {
  if (!isString(skillPath) || !skillPath) return null;
  const parts = skillPath.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? '';
  const id = file === 'SKILL.md' ? parts.at(-2) : (file.endsWith('.md') ? file.slice(0, -3) : null);
  return isValidSkillPolicyId(id) ? id : null;
}

const isStatement = (value) => isPlainObject(value)
  && isString(value.action)
  && isString(value.resource)
  && (value.effect === 'allow' || value.effect === 'deny');

const ownedResource = (id) => `${SKILL_RESOURCE_PREFIX}${id}`;

// The provenance key on a statement a switch wrote. See the module comment.
const OWNER_KEY = 'openchamber';
const OWNER_VALUE = 'skill-switch';

const ownedStatement = (id) => ({ action: INTEGRATION_USE, resource: ownedResource(id), effect: 'deny', [OWNER_KEY]: OWNER_VALUE });

/** The statement a switch writes, and the only one it ever removes. */
const isOwnedStatement = (value, id) => isStatement(value)
  && value.action === INTEGRATION_USE
  && value.resource === ownedResource(id)
  && value.effect === 'deny'
  && value[OWNER_KEY] === OWNER_VALUE;

const readPath = (config, keyPath) => {
  let current = config;
  for (const key of keyPath) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
};

const readArray = (config, keyPath) => {
  const value = readPath(config, keyPath);
  return Array.isArray(value) ? value : [];
};

/**
 * OpenCode's `Wildcard.match`: `*` is any run, `?` one character, a trailing
 * ` *` also matches nothing. Same as the UI's `matchesWildcard` in
 * `lib/opencode/projection.ts`.
 */
function matchesWildcard(input, pattern) {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

const lastMatchIn = (statements, id) => {
  const resource = ownedResource(id);
  let match = null;
  for (const statement of statements) {
    if (isStatement(statement) && statement.action === INTEGRATION_USE && matchesWildcard(resource, statement.resource)) {
      match = statement;
    }
  }
  return match;
};

// The statements a version enforces, in order. An unknown `location` (OpenCode
// not reachable) counts both arrays.
const enforcedStatements = (config, location) => enforcedPaths(location ?? SKILL_POLICY_LOCATION.TOP_LEVEL)
  .flatMap((keyPath) => readArray(config, keyPath));

/** Every id a config file switches off with a switch's own marked deny. */
export function listOwnedSkillDenies(config, location = null) {
  const ids = new Set();
  for (const statement of enforcedStatements(config, location)) {
    if (!isStatement(statement) || !statement.resource.startsWith(SKILL_RESOURCE_PREFIX)) continue;
    const id = statement.resource.slice(SKILL_RESOURCE_PREFIX.length);
    if (isValidSkillPolicyId(id) && isOwnedStatement(statement, id)) ids.add(id);
  }
  return [...ids];
}

/** Whether `id`'s last matching statement in one config file is a switch's own deny. */
const isDecidedByOwnedDeny = (config, id, location) => isOwnedStatement(lastMatchIn(enforcedStatements(config, location), id), id);

// The enforced statements as OpenCode serves them back: its decoder drops the
// provenance key, so a served document is compared on these three fields.
const servedForm = (config, location) => enforcedStatements(config, location)
  .filter(isStatement)
  .map(({ action, resource, effect }) => [action, resource, effect]);

class SkillPolicyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillPolicyConfigError';
    this.code = 'SKILL_POLICY_CONFIG_SHAPE';
  }
}

/**
 * Turn `id` off (`disabled: true`) or back on in one config object, in place.
 * Returns whether the object changed.
 *
 * Off appends the switch's marked deny to the version's write array unless a
 * deny (the switch's own, the user's exact one, or a wildcard) already decides
 * `id` in this file. On removes the marked denies for `id` from the arrays the
 * version enforces. An array it empties stays, empty, and so does its
 * `experimental` object: the file cannot tell an array the switch added from
 * one the user wrote. A statement without the provenance key is never
 * removed, so a user's exact deny survives an off/on round trip. Nothing else
 * in the file moves.
 */
export function setSkillDisabled(config, id, disabled, location) {
  if (!isPlainObject(config)) throw new SkillPolicyConfigError('The config file is not an object');
  if (!isValidSkillPolicyId(id)) throw new SkillPolicyConfigError(`Invalid skill id "${id}"`);
  if (location !== SKILL_POLICY_LOCATION.TOP_LEVEL && location !== SKILL_POLICY_LOCATION.EXPERIMENTAL) {
    throw new SkillPolicyConfigError('Unknown policy location');
  }

  if (disabled) {
    if (lastMatchIn(enforcedStatements(config, location), id)?.effect === 'deny') return false;
    const [first, second] = writePath(location);
    let parent = config;
    if (second) {
      if (parent[first] === undefined) parent[first] = {};
      if (!isPlainObject(parent[first])) throw new SkillPolicyConfigError(`"${first}" in the config file is not an object`);
      parent = parent[first];
    }
    const key = second ?? first;
    if (parent[key] === undefined) parent[key] = [];
    if (!Array.isArray(parent[key])) throw new SkillPolicyConfigError(`"${writePath(location).join('.')}" in the config file is not a list`);
    parent[key].push(ownedStatement(id));
    return true;
  }

  let changed = false;
  for (const keyPath of enforcedPaths(location)) {
    const parent = keyPath.length === 2 ? readPath(config, [keyPath[0]]) : config;
    const key = keyPath.at(-1);
    if (!isPlainObject(parent) || !Array.isArray(parent[key])) continue;
    const kept = parent[key].filter((statement) => !isOwnedStatement(statement, id));
    if (kept.length === parent[key].length) continue;
    changed = true;
    parent[key] = kept;
  }
  return changed;
}

/**
 * Rename support: next to every switch-owned deny for `oldId`, append the
 * switch's deny for `newId` in the same array, so the new rule has the format
 * (and so the OpenCode versions) the old one was written for. An array that
 * already holds the switch's deny for `newId` is left alone. User-written
 * rules are never read as owned and never copied. Returns the key paths it
 * appended to, in place.
 */
export function carryOwnedSkillDeny(config, oldId, newId) {
  if (!isPlainObject(config) || !isValidSkillPolicyId(oldId) || !isValidSkillPolicyId(newId)) return [];
  const appended = [];
  for (const keyPath of [EXPERIMENTAL_PATH, TOP_LEVEL_PATH]) {
    const list = readPath(config, keyPath);
    if (!Array.isArray(list) || !list.some((statement) => isOwnedStatement(statement, oldId))) continue;
    if (list.some((statement) => isOwnedStatement(statement, newId))) continue;
    list.push(ownedStatement(newId));
    appended.push(keyPath);
  }
  return appended;
}

// Undo of `carryOwnedSkillDeny`: drop the last switch-owned deny for `id` from
// each array it appended to. The arrays stay, as in `setSkillDisabled`.
const removeCarriedDeny = (config, id, keyPaths) => {
  let changed = false;
  for (const keyPath of keyPaths) {
    const parent = keyPath.length === 2 ? readPath(config, [keyPath[0]]) : config;
    const key = keyPath.at(-1);
    if (!isPlainObject(parent) || !Array.isArray(parent[key])) continue;
    const index = parent[key].findLastIndex((statement) => isOwnedStatement(statement, id));
    if (index === -1) continue;
    parent[key].splice(index, 1);
    changed = true;
  }
  return changed;
};

const isDocument = (entry) => isPlainObject(entry) && entry.type === 'document' && isPlainObject(entry.info);

/**
 * The statement that decides `id` across OpenCode's config documents, as
 * `GET /api/config` serves them (lowest priority first). OpenCode evaluates
 * the documents reversed and lets the last match win, so a global rule beats a
 * project one in either direction. Only the arrays the version enforces count:
 * 2.0.25 to 2.0.28 ignore top-level `policies`. `null` means no rule matches:
 * the skill is allowed. Console statements are not part of `/api/config`.
 */
export function findDecidingSkillStatement(entries, id, location = null) {
  let decided = null;
  for (const entry of [...entries].filter(isDocument).reverse()) {
    const match = lastMatchIn(enforcedStatements(entry.info, location), id);
    if (match) decided = { path: isString(entry.path) ? entry.path : null, resource: match.resource, effect: match.effect };
  }
  return decided;
}

const UNKNOWN = 'unknown';

/**
 * One skill's policy state for the UI.
 * - `disabledIn`: whether the switch's own rule is saved in each scope's file.
 *   A file that does not exist yet reads as `{}`, so it is `false`; `null`
 *   means the directory has no such scope, or its file could not be read.
 * - `effective`: what OpenCode applies (`unknown` when its config could not be
 *   read; never inferred from a missing skill). Also `unknown` while a scope's
 *   own file cannot be read (`scopes[scope].error`) and no deny decides the
 *   skill: OpenCode leaves an unparsable file out of `GET /api/config`, so a
 *   switch's deny in it is missing from what it serves, and the absence of a
 *   deny proves nothing. A deny that still decides it keeps it `disabled`.
 * - `decidedBy`: the statement that decides it and its file; `scope` says
 *   which switch owns that file (`other` for any file a switch never writes),
 *   `owned` whether it is a switch's own marked deny. OpenCode serves
 *   statements without the provenance key, so `owned` is read from the
 *   scope's file itself.
 *
 * `configs` holds each scope's parsed file, `null` when unavailable.
 */
function describeSkillPolicy(id, { entries, scopes, configs, location, samePath }) {
  const disabledIn = {};
  for (const scope of SKILL_POLICY_SCOPES) {
    disabledIn[scope] = configs[scope] ? listOwnedSkillDenies(configs[scope], location).includes(id) : null;
  }
  if (!entries) return { disabledIn, effective: UNKNOWN, decidedBy: null };

  const decided = findDecidingSkillStatement(entries, id, location);
  const scopeUnreadable = SKILL_POLICY_SCOPES.some((name) => scopes[name]?.error);
  if (scopeUnreadable && decided?.effect !== 'deny') return { disabledIn, effective: UNKNOWN, decidedBy: null };
  if (!decided) return { disabledIn, effective: 'enabled', decidedBy: null };
  const scope = SKILL_POLICY_SCOPES.find((name) => scopes[name] && decided.path && samePath(scopes[name].path, decided.path)) ?? 'other';
  return {
    disabledIn,
    effective: decided.effect === 'deny' ? 'disabled' : 'enabled',
    decidedBy: {
      ...decided,
      scope,
      owned: scope !== 'other' && configs[scope] !== null && isDecidedByOwnedDeny(configs[scope], id, location),
    },
  };
}

const realPathOrResolved = (filePath) => {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
};

// A config path OpenCode reports and the one OpenChamber computes can differ
// only by a link on the way (a linked `~/.config`, a linked project root).
const defaultSamePath = (left, right) => isString(left)
  && isString(right)
  && (path.resolve(left) === path.resolve(right) || realPathOrResolved(left) === realPathOrResolved(right));

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const statusError = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * @param {object} dependencies
 * @param {(directory: string | null) => { global: string, project: string | null }} dependencies.resolveTargets
 *   The config file each scope writes; project is `null` without a directory.
 * @param {(filePath: string) => object} dependencies.readConfigFile throws on invalid JSONC
 * @param {(config: object, filePath: string) => void} dependencies.writeConfig comment-preserving writer
 * @param {(left: string, right: string) => boolean} [dependencies.samePath]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @param {number} [dependencies.confirmAttempts] OpenCode reads after a write before reporting it unconfirmed
 * @param {number} [dependencies.confirmDelayMs]
 */
export function createSkillPolicyService({
  resolveTargets,
  readConfigFile,
  writeConfig,
  samePath = defaultSamePath,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmAttempts = 8,
  confirmDelayMs = 250,
}) {
  // Writes run one at a time per process: read, change and write a file as
  // one step, so two switches flipped together cannot drop each other's rule.
  let writeQueue = Promise.resolve();
  const serialize = (task) => {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  };

  const readScopes = (directory) => {
    const targets = resolveTargets(directory);
    const scopes = { global: { path: targets.global, error: null }, project: null };
    // A project directory whose config file is the global one (a project
    // opened at the OpenCode config directory) has no separate project scope.
    if (targets.project && !samePath(targets.project, targets.global)) {
      scopes.project = { path: targets.project, error: null };
    }
    return scopes;
  };

  // Each scope's parsed file; an unreadable one is `null` with its error on the scope.
  const readConfigs = (scopes) => {
    const configs = { global: null, project: null };
    for (const scope of SKILL_POLICY_SCOPES) {
      const target = scopes[scope];
      if (!target) continue;
      try {
        configs[scope] = readConfigFile(target.path);
        target.error = null;
      } catch (error) {
        target.error = errorMessage(error);
      }
    }
    return configs;
  };

  const readOpenCode = async (openCode, directory) => {
    const [version, entries] = await Promise.all([
      openCode.readVersion().catch(() => null),
      openCode.readConfigEntries(directory).catch(() => null),
    ]);
    return { version, entries: Array.isArray(entries) ? entries : null };
  };

  const summarize = ({ version, location, entries, scopes }) => ({
    version,
    location,
    // `null`: OpenCode could not be read, or it enforces no skill policies.
    // Switches are read-only then; saved rules still show.
    writable: location !== null,
    effectiveAvailable: entries !== null,
    scopes,
  });

  /**
   * The policy state of `ids` in `directory`, plus every id a scope's file
   * switches off even when no skill with that id is installed any more, so it
   * can still be switched back on.
   */
  const readState = async ({ directory, ids, openCode }) => {
    const { version, entries } = await readOpenCode(openCode, directory);
    const location = skillPolicyLocation(version);
    const scopes = readScopes(directory);
    const configs = readConfigs(scopes);
    const allIds = new Set(ids.filter(isValidSkillPolicyId));
    for (const config of Object.values(configs)) for (const id of config ? listOwnedSkillDenies(config, location) : []) allIds.add(id);
    // A list with the id as a value: every valid id, `__proto__` included,
    // survives JSON and the UI's parser, which an object keyed by id does not.
    const skills = [...allIds].map((id) => ({ id, ...describeSkillPolicy(id, { entries, scopes, configs, location, samePath }) }));
    return { ...summarize({ version, location, entries, scopes }), skills };
  };

  // OpenCode has picked the file up when it serves the same enforced
  // statements the file holds (a missing document counts as none).
  const isConfirmed = (entries, targetPath, config, location) => {
    const document = entries.find((entry) => isDocument(entry) && isString(entry.path) && samePath(entry.path, targetPath));
    return JSON.stringify(servedForm(document?.info ?? {}, location)) === JSON.stringify(servedForm(config, location));
  };

  /**
   * Save `enabled` for `id` in one scope's file, then wait briefly for
   * OpenCode to pick it up. A failed write throws and changes nothing; a write
   * OpenCode has not confirmed yet resolves with `confirmed: false` and the
   * last state OpenCode reported (or `unknown`).
   */
  const setEnabled = async ({ directory, id, scope, enabled, openCode }) => {
    if (!isValidSkillPolicyId(id)) throw statusError(400, 'invalid_id', 'Invalid skill id');
    if (!SKILL_POLICY_SCOPES.includes(scope)) throw statusError(400, 'invalid_scope', 'Scope must be "global" or "project"');
    if (!isBoolean(enabled)) throw statusError(400, 'invalid_enabled', '"enabled" must be true or false');

    const version = await openCode.readVersion().catch(() => null);
    const location = skillPolicyLocation(version);
    if (!location) {
      throw version
        ? statusError(409, 'unsupported_version', `OpenCode ${version} does not enforce skill policies; 2.0.25 or newer does`)
        : statusError(503, 'opencode_unavailable', 'OpenCode is not reachable, so the skill switch cannot be saved');
    }

    const scopes = readScopes(directory);
    const target = scopes[scope];
    if (!target) throw statusError(409, 'scope_unavailable', 'This directory has no separate project config');

    const { config: written, changed } = await serialize(() => {
      let config;
      try {
        config = readConfigFile(target.path);
      } catch (error) {
        throw statusError(409, error?.code === 'INVALID_JSONC' ? 'invalid_config' : 'read_failed', errorMessage(error));
      }
      let didChange;
      try {
        didChange = setSkillDisabled(config, id, !enabled, location);
      } catch (error) {
        throw statusError(409, 'invalid_config', errorMessage(error));
      }
      if (didChange) writeConfig(config, target.path);
      return { config, changed: didChange };
    });

    // `disabled` is whether the scope's file now holds the switch's own deny:
    // off answers `false` when a deny the switch did not write already
    // decided the skill there, so nothing was added.
    const saved = { scope, path: target.path, disabled: listOwnedSkillDenies(written, location).includes(id), changed };
    let entries = null;
    let confirmed = false;
    for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
      if (attempt > 0) await sleep(confirmDelayMs);
      entries = await openCode.readConfigEntries(directory).then((value) => (Array.isArray(value) ? value : null), () => null);
      if (entries && isConfirmed(entries, target.path, written, location)) {
        confirmed = true;
        break;
      }
    }

    const configs = readConfigs(scopes);
    return {
      saved,
      confirmed,
      state: summarize({ version, location, entries, scopes }),
      policy: describeSkillPolicy(id, { entries, scopes, configs, location, samePath }),
    };
  };

  /**
   * Keep a renamed skill off where a switch turned it off (#3075 decision):
   * the switch-owned deny for `oldId` is carried to `newId` in this
   * directory's scope files, the global one and the project one. No other
   * project's config is opened, and user-written rules stay as they are.
   *
   * Called before the folder moves. Every scope file is read first; one that
   * cannot be read stops the rename (409) before anything is written, since
   * it may hold a switch's deny the rename would otherwise lose. Then the new
   * deny is written next to the old one before the folder moves. OpenCode
   * applies both through its own file watchers, which run asynchronously, so
   * the order of the writes is not a guarantee of what OpenCode loads first:
   * for a short time it may list the new id before it applies the deny. A
   * failed write restores the files already written and stops the rename.
   *
   * Answers a handle: `owning` lists the scope files holding the old id's
 * switch rule, `carried` the ones the new rule was written to (a file that
 * already had the new id's switch rule is in `owning` only). `undo()` takes
 * the carried rules out again (the folder
   * did not move); `finish()` removes the old id's switch-owned deny once the
   * folder moved, unless `keepOldRules` (another copy of the old id is still
   * installed and must stay off). Both report what they could not do instead
   * of throwing.
   */
  const carryForRename = async ({ directory, oldId, newId, keepOldRules }) => {
    if (!isValidSkillPolicyId(oldId) || !isValidSkillPolicyId(newId) || oldId === newId) {
      return { owning: [], carried: [], undo: async () => [], finish: async () => ({ removed: [], kept: [], failed: [] }) };
    }
    const scopes = readScopes(directory);
    const targets = SKILL_POLICY_SCOPES.flatMap((scope) => (scopes[scope] ? [{ scope, path: scopes[scope].path }] : []));

    const owning = [];
    for (const target of targets) {
      let config;
      try {
        config = readConfigFile(target.path);
      } catch (error) {
        throw statusError(409, 'invalid_config', `The skill was not renamed: ${errorMessage(error)}`);
      }
      if (listOwnedSkillDenies(config).includes(oldId)) owning.push(target);
    }

    const carried = [];
    const restore = () => serialize(() => {
      const failed = [];
      for (const entry of carried.splice(0).reverse()) {
        try {
          const config = readConfigFile(entry.path);
          if (removeCarriedDeny(config, newId, entry.appended)) writeConfig(config, entry.path);
        } catch (error) {
          failed.push({ scope: entry.scope, path: entry.path, error: errorMessage(error) });
        }
      }
      return failed;
    });

    try {
      await serialize(() => {
        for (const target of owning) {
          const config = readConfigFile(target.path);
          const appended = carryOwnedSkillDeny(config, oldId, newId);
          if (appended.length === 0) continue;
          writeConfig(config, target.path);
          carried.push({ ...target, appended });
        }
      });
    } catch (error) {
      const failedRestore = await restore();
      const leftover = failedRestore.length > 0 ? ` Restoring ${failedRestore.map((entry) => entry.path).join(', ')} also failed.` : '';
      throw statusError(500, 'write_failed', `The skill was not renamed: its switch could not be kept off (${errorMessage(error)}).${leftover}`);
    }

    const carriedScopes = carried.map(({ scope, path: filePath }) => ({ scope, path: filePath }));
    return {
      owning: owning.map(({ scope, path: filePath }) => ({ scope, path: filePath })),
      carried: carriedScopes,
      undo: restore,
      finish: () => serialize(() => {
        const outcome = { removed: [], kept: [], failed: [] };
        for (const target of owning) {
          if (keepOldRules) {
            outcome.kept.push(target);
            continue;
          }
          try {
            const config = readConfigFile(target.path);
            if (setSkillDisabled(config, oldId, false, SKILL_POLICY_LOCATION.TOP_LEVEL)) writeConfig(config, target.path);
            outcome.removed.push(target);
          } catch (error) {
            outcome.failed.push({ ...target, error: errorMessage(error) });
          }
        }
        return outcome;
      }),
    };
  };

  return { readState, setEnabled, carryForRename };
}

/**
 * A skill rename that keeps the skill off where a switch turned it off. Both
 * runtimes call it around their own rename:
 * `rename(beforeMove)` runs the rename with the `beforeMove({ oldPath,
 * newPath })` hook it is handed, and `listSkillFiles(directory)` lists every
 * skill file on disk with its id (copies included), which decides whether
 * the old id's switch rule must stay for another copy.
 *
 * Resolves to `{ newPath, switches }`. `switches` is null when there was no
 * switch rule to carry (or the id did not change), else `{ carried,
 * oldRuleRemoved, oldRuleKept, oldRuleCleanupFailed }`, each a list of
 * `{ scope, path }` (`error` on a failed cleanup). A rename that fails throws;
 * the carried rules are taken out again when the folder did not move, and a
 * restore that failed is named in the error message.
 */
export async function renameSkillKeepingSwitches({ service, directory, listSkillFiles, rename }) {
  let carry = null;
  let undoFailed = [];
  const beforeMove = async ({ oldPath, newPath }) => {
    const oldId = skillIdFromPath(oldPath);
    const newId = skillIdFromPath(newPath);
    if (!oldId || !newId || oldId === newId) return null;
    const resolvedOld = path.resolve(oldPath);
    const keepOldRules = (await listSkillFiles(directory))
      .some((skill) => skill?.id === oldId && isString(skill.path) && path.resolve(skill.path) !== resolvedOld);
    carry = await service.carryForRename({ directory, oldId, newId, keepOldRules });
    return { undo: async () => { undoFailed = await carry.undo(); } };
  };

  let newPath;
  try {
    newPath = await rename(beforeMove);
  } catch (error) {
    if (undoFailed.length > 0 && error instanceof Error) {
      error.message = `${error.message} The switch rules added for the new name could not be removed from ${undoFailed.map((entry) => entry.path).join(', ')}.`;
    }
    throw error;
  }
  if (!carry || carry.owning.length === 0) {
    return { newPath, switches: null };
  }
  const outcome = await carry.finish();
  return {
    newPath,
    switches: {
      carried: carry.carried,
      oldRuleRemoved: outcome.removed,
      oldRuleKept: outcome.kept,
      oldRuleCleanupFailed: outcome.failed,
    },
  };
}

/**
 * The write route both runtimes serve (`PUT /api/config/skill-policy`, body
 * `{ id, scope, enabled }`). `directory` is already validated by the runtime;
 * the project scope needs one. Only an installed id can be switched off;
 * switching on never adds a statement, so it needs no inventory check.
 * Answers `{ status, body }` instead of throwing.
 *
 * @param {object} input
 * @param {ReturnType<typeof createSkillPolicyService>} input.service
 * @param {(directory: string | null) => Promise<Set<string>>} input.listInstalledSkillIds
 */
export async function handleSkillPolicyWrite({ service, body, directory, openCode, listInstalledSkillIds }) {
  const id = isPlainObject(body) ? body.id : undefined;
  const scope = isPlainObject(body) ? body.scope : undefined;
  const enabled = isPlainObject(body) ? body.enabled : undefined;
  try {
    if (scope === 'project' && !directory) throw statusError(400, 'directory_required', 'The project scope needs a directory');
    if (enabled === false && isValidSkillPolicyId(id) && !(await listInstalledSkillIds(directory)).has(id)) {
      throw statusError(404, 'unknown_skill', `No installed skill has the id "${id}"`);
    }
    const result = await service.setEnabled({ directory, id, scope, enabled, openCode });
    return { status: 200, body: { ok: true, id, ...result } };
  } catch (error) {
    if (Number.isInteger(error?.status)) {
      return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
    }
    console.error('Failed to save skill policy:', error);
    return { status: 500, body: { ok: false, error: { code: 'write_failed', message: errorMessage(error) } } };
  }
}
