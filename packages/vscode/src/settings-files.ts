import * as fs from 'fs';
import * as path from 'path';
import { SETTINGS_REGISTRY_FIELDS } from './settings-registry-gate';

const PREFERENCES_FILE_NAME = 'preferences.json';
const PREFERENCES_DOCUMENT_VERSION = 1;

type SettingsSurface = 'web' | 'desktop' | 'vscode' | 'mobile';
const SETTINGS_SURFACES: readonly SettingsSurface[] = ['web', 'desktop', 'vscode', 'mobile'];
// SAFETY: widening the tuple to `readonly string[]` only for the membership test; the guard's result is what narrows.
const isSettingsSurface = (value: string): value is SettingsSurface => (SETTINGS_SURFACES as readonly string[]).includes(value);

export const VSCODE_SETTINGS_SURFACE: SettingsSurface = 'vscode';

type SurfaceValue = { value: unknown; updatedAt: number };
type PreferenceField = { value?: unknown; updatedAt: number; surfaces?: Partial<Record<SettingsSurface, SurfaceValue>> };
export type PreferenceFields = Record<string, PreferenceField>;

type ParsedPreferencesDocument =
  | { ok: true; fields: PreferenceFields }
  | { ok: false; reason: string };

const getSettingsScope = (key: string): string | null =>
  Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY_FIELDS, key) ? SETTINGS_REGISTRY_FIELDS[key].scope : null;

const isBlankSettingsText = (text: string): boolean => /^[\s\0]*$/.test(text);

export const readSettingsFileTextSync = (filePath: string, onSetAside: (backupName: string) => void): string => {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!isBlankSettingsText(text)) return text;
  const backupPath = `${filePath}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(filePath, backupPath);
    onSetAside(path.basename(backupPath));
    console.warn(`[OpenChamber] ${path.basename(filePath)} held no settings; moved it to ${path.basename(backupPath)} and starting it fresh.`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  throw Object.assign(new Error(`${path.basename(filePath)} held no settings`), { code: 'ENOENT' });
};

export const isProfileSettingsKey = (key: string): boolean => getSettingsScope(key) === 'profile';
export const isDeviceSettingsKey = (key: string): boolean => getSettingsScope(key) === 'device';
export const isPerSurfaceSettingsKey = (key: string): boolean =>
  Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY_FIELDS, key) && SETTINGS_REGISTRY_FIELDS[key].perSurface === true;

export const preferencesFilePathFor = (settingsFilePath: string): string =>
  path.join(path.dirname(settingsFilePath), PREFERENCES_FILE_NAME);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseStamp = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

export const parsePreferencesDocument = (raw: string): ParsedPreferencesDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(parsed) || parsed.version !== PREFERENCES_DOCUMENT_VERSION || !isPlainObject(parsed.fields)) {
    return { ok: false, reason: 'not a version-1 preferences document' };
  }
  const fields: PreferenceFields = {};
  for (const [key, entry] of Object.entries(parsed.fields)) {
    if (!isPlainObject(entry) || (!('value' in entry) && !isPlainObject(entry.surfaces))) {
      return { ok: false, reason: `field "${key}" is not a { value, updatedAt } entry` };
    }
    const next: PreferenceField = { updatedAt: parseStamp(entry.updatedAt) };
    if ('value' in entry) next.value = entry.value;
    if (isPlainObject(entry.surfaces)) {
      const surfaces: Partial<Record<SettingsSurface, SurfaceValue>> = {};
      for (const [surface, surfaceEntry] of Object.entries(entry.surfaces)) {
        if (!isSettingsSurface(surface) || !isPlainObject(surfaceEntry) || !('value' in surfaceEntry)) {
          return { ok: false, reason: `field "${key}" has an invalid surface entry "${surface}"` };
        }
        surfaces[surface] = { value: surfaceEntry.value, updatedAt: parseStamp(surfaceEntry.updatedAt) };
      }
      next.surfaces = surfaces;
    }
    fields[key] = next;
  }
  return { ok: true, fields };
};

export const serializePreferencesDocument = (fields: PreferenceFields): string =>
  JSON.stringify({ version: PREFERENCES_DOCUMENT_VERSION, fields }, null, 2);

export const flattenPreferences = (fields: PreferenceFields, surface: SettingsSurface | null = null): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const own = surface ? entry.surfaces?.[surface] : undefined;
    if (own) {
      values[key] = own.value;
    } else if ('value' in entry) {
      values[key] = entry.value;
    }
  }
  return values;
};

export const buildPreferencesFields = (
  previousFields: PreferenceFields,
  document: Record<string, unknown>,
  now: number,
  options: { surface?: SettingsSurface | null; changedKeys?: Iterable<string> | null } = {},
): PreferenceFields => {
  const surface = options.surface ?? null;
  const changed = options.changedKeys ? new Set(options.changedKeys) : null;
  const fields: PreferenceFields = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || !isProfileSettingsKey(key)) continue;
    const previous = previousFields[key];
    if (surface && isPerSurfaceSettingsKey(key)) {
      if (changed && !changed.has(key)) {
        if (previous) fields[key] = previous;
        continue;
      }
      const previousOwn = previous?.surfaces?.[surface];
      const own: SurfaceValue = previousOwn && sameValue(previousOwn.value, value) ? previousOwn : { value, updatedAt: now };
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

export const instancePartOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const instance: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || isProfileSettingsKey(key)) continue;
    instance[key] = value;
  }
  return instance;
};

export const profilePartOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const profile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined && isProfileSettingsKey(key)) profile[key] = value;
  }
  return profile;
};

export const legacySettingsDocumentOf = (
  document: Record<string, unknown>,
  preferenceFields: PreferenceFields,
): Record<string, unknown> => ({
  ...instancePartOf(document),
  ...flattenPreferences(preferenceFields),
});

export const seedPreferencesFrom = (document: Record<string, unknown>, now: number): PreferenceFields =>
  buildPreferencesFields({}, document, now);
