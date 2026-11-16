import { createRequire } from 'node:module';

const registry = createRequire(import.meta.url)('./settings-registry.json');

const PREFERENCES_FILE_NAME = 'preferences.json';
const PREFERENCES_DOCUMENT_VERSION = 1;

const getSettingsScope = (key) => registry.fields[key]?.scope ?? null;

export const isProfileSettingsKey = (key) => getSettingsScope(key) === 'profile';
export const isDeviceSettingsKey = (key) => getSettingsScope(key) === 'device';

const isPerSurfaceSettingsKey = (key) => registry.fields[key]?.perSurface === true;

const SETTINGS_SURFACES = Object.freeze(['web', 'desktop', 'vscode', 'mobile']);

export const normalizeSettingsSurface = (value) => (
  typeof value === 'string' && SETTINGS_SURFACES.includes(value.trim()) ? value.trim() : null
);

export const settingsSurfaceOf = (req) => (
  normalizeSettingsSurface(req.query?.surface) ?? normalizeSettingsSurface(req.get?.('x-openchamber-surface'))
);

export const preferencesFilePathFor = (settingsFilePath, path) => path.join(path.dirname(settingsFilePath), PREFERENCES_FILE_NAME);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sameValue = (left, right) => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const parseStamp = (value) => (Number.isFinite(value) ? value : 0);

export const parsePreferencesDocument = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(parsed) || parsed.version !== PREFERENCES_DOCUMENT_VERSION || !isPlainObject(parsed.fields)) {
    return { ok: false, reason: 'not a version-1 preferences document' };
  }
  const fields = {};
  for (const [key, entry] of Object.entries(parsed.fields)) {
    if (!isPlainObject(entry) || (!('value' in entry) && !isPlainObject(entry.surfaces))) {
      return { ok: false, reason: `field "${key}" is not a { value, updatedAt } entry` };
    }
    const next = { updatedAt: parseStamp(entry.updatedAt) };
    if ('value' in entry) next.value = entry.value;
    if (isPlainObject(entry.surfaces)) {
      next.surfaces = {};
      for (const [surface, surfaceEntry] of Object.entries(entry.surfaces)) {
        if (!SETTINGS_SURFACES.includes(surface) || !isPlainObject(surfaceEntry) || !('value' in surfaceEntry)) {
          return { ok: false, reason: `field "${key}" has an invalid surface entry "${surface}"` };
        }
        next.surfaces[surface] = { value: surfaceEntry.value, updatedAt: parseStamp(surfaceEntry.updatedAt) };
      }
    }
    fields[key] = next;
  }
  return { ok: true, fields };
};

export const serializePreferencesDocument = (fields) => JSON.stringify({ version: PREFERENCES_DOCUMENT_VERSION, fields }, null, 2);

export const flattenPreferences = (fields, surface = null) => {
  const values = {};
  for (const [key, entry] of Object.entries(fields)) {
    const own = surface && entry.surfaces ? entry.surfaces[surface] : undefined;
    if (own) {
      values[key] = own.value;
    } else if ('value' in entry) {
      values[key] = entry.value;
    }
  }
  return values;
};

export const buildPreferencesFields = (previousFields, document, now, { surface = null, changedKeys = null } = {}) => {
  const fields = {};
  const changed = changedKeys ? new Set(changedKeys) : null;
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || !isProfileSettingsKey(key)) continue;
    const previous = previousFields[key];
    if (isPerSurfaceSettingsKey(key) && surface) {
      if (changed && !changed.has(key)) {
        if (previous) fields[key] = previous;
        continue;
      }
      const previousOwn = previous?.surfaces?.[surface];
      const own = previousOwn && sameValue(previousOwn.value, value) ? previousOwn : { value, updatedAt: now };
      fields[key] = {
        ...(previous ?? { updatedAt: 0 }),
        surfaces: { ...(previous?.surfaces ?? {}), [surface]: own },
      };
      continue;
    }
    if (previous && 'value' in previous && sameValue(previous.value, value)) {
      fields[key] = previous;
    } else {
      fields[key] = { ...(previous ?? {}), value, updatedAt: now };
    }
  }
  for (const [key, previous] of Object.entries(previousFields)) {
    if (key in fields || !isPerSurfaceSettingsKey(key)) continue;
    const visibleToWriter = 'value' in previous || Boolean(surface && previous.surfaces?.[surface]);
    if (!visibleToWriter) fields[key] = previous;
  }
  return fields;
};

export const instancePartOf = (document) => {
  const instance = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || isProfileSettingsKey(key)) continue;
    instance[key] = value;
  }
  return instance;
};

export const profilePartOf = (document) => {
  const profile = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined && isProfileSettingsKey(key)) profile[key] = value;
  }
  return profile;
};

export const legacySettingsDocumentOf = (document, preferenceFields) => ({
  ...instancePartOf(document),
  ...flattenPreferences(preferenceFields),
});

export const seedPreferencesFrom = (document, now) => buildPreferencesFields({}, document, now);

export const readMergedSettingsSync = ({ fs, path, settingsFilePath }) => {
  let settings = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    if (isPlainObject(parsed)) settings = parsed;
  } catch {
    settings = {};
  }
  let preferences = {};
  try {
    const parsed = parsePreferencesDocument(fs.readFileSync(preferencesFilePathFor(settingsFilePath, path), 'utf8'));
    if (parsed.ok) preferences = flattenPreferences(parsed.fields);
  } catch {
    preferences = {};
  }
  return { ...settings, ...preferences };
};
