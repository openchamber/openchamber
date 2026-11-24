import { createRequire } from 'node:module';
import type fsModule from 'node:fs';
import type pathModule from 'node:path';
import type { SettingsDocument } from './settings-helpers.js';
import type { Query } from '../shared/http-contracts.js';
import { isString } from '../shared/object-guards.js';

const registry: { fields: Record<string, {
  scope?: string;
  perSurface?: boolean;
  owner?: string;
  computed?: boolean;
  secret?: boolean;
}> } = createRequire(import.meta.url)('./settings-registry.json');

export type SettingsSurface = 'web' | 'desktop' | 'vscode' | 'mobile';
export interface PreferenceField {
  value?: SettingsDocument[string];
  updatedAt: number;
  surfaces?: Partial<Record<SettingsSurface, { value: SettingsDocument[string]; updatedAt: number }>>;
}
export type PreferenceFields = Record<string, PreferenceField>;
export type PreferencesParseResult = { ok: false; reason: string } | { ok: true; fields: PreferenceFields };
export interface PreferencesWriteOptions {
  surface?: SettingsSurface | null;
  changedKeys?: Iterable<string> | null;
}

const PREFERENCES_FILE_NAME = 'preferences.json';
const PREFERENCES_DOCUMENT_VERSION = 1;

const getSettingsScope = (key: string) => registry.fields[key]?.scope ?? null;

export type PreferenceReadResult =
  | { status: 'missing'; revision?: number }
  | { status: 'failed'; fields?: PreferenceFields | undefined; revision?: number }
  | { status: 'ok'; fields: PreferenceFields; revision: number; missing: boolean | undefined };

const TEMP_FILE_IN_USE_MS = 60_000;

export const isAbandonedSettingsTempFile = (name: string, now: number) => {
  const match = /^(?:settings|preferences)\.json\.tmp-(?:\d+-(\d+)-)?/.exec(name);
  return match !== null && now - Number(match[1] ?? 0) > TEMP_FILE_IN_USE_MS;
};

export const isProfileSettingsKey = (key: string) => getSettingsScope(key) === 'profile';
export const isDeviceSettingsKey = (key: string) => getSettingsScope(key) === 'device';
export const isNotifiableSettingsKey = (key: string) => {
  const field = Object.hasOwn(registry.fields, key) ? registry.fields[key] : null;
  return Boolean(field && field.scope !== 'device' && field.owner !== 'desktop-shell' && !field.computed && !field.secret);
};

const isPerSurfaceSettingsKey = (key: string) => registry.fields[key]?.perSurface === true;

const SETTINGS_SURFACES = Object.freeze(['web', 'desktop', 'vscode', 'mobile']);

const isSettingsSurface = (value: string): value is SettingsSurface => SETTINGS_SURFACES.includes(value);
export const normalizeSettingsSurface = (value: SettingsDocument[string]) => {
  const trimmed = isString(value) ? value.trim() : null;
  return trimmed !== null && isSettingsSurface(trimmed) ? trimmed : null;
};

export const settingsSurfaceOf = (req: { query?: Query; get?(header: string): string | string[] | undefined }) => (
  normalizeSettingsSurface(req.query?.surface) ?? normalizeSettingsSurface(req.get?.('x-openchamber-surface'))
);

export const preferencesFilePathFor = (settingsFilePath: string, path: Pick<typeof pathModule, 'join' | 'dirname'>) => path.join(path.dirname(settingsFilePath), PREFERENCES_FILE_NAME);

const isPlainObject = (value: unknown): value is SettingsDocument => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

const sameValue = (left: SettingsDocument[string], right: SettingsDocument[string]) => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const parseStamp = (value: SettingsDocument[string]) => (isFiniteNumber(value) ? value : 0);

export const parsePreferencesDocument = (raw: string): PreferencesParseResult => {
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
      next.surfaces = {};
      for (const [surface, surfaceEntry] of Object.entries(entry.surfaces)) {
        if (!isSettingsSurface(surface) || !isPlainObject(surfaceEntry) || !('value' in surfaceEntry)) {
          return { ok: false, reason: `field "${key}" has an invalid surface entry "${surface}"` };
        }
        next.surfaces[surface] = { value: surfaceEntry.value, updatedAt: parseStamp(surfaceEntry.updatedAt) };
      }
    }
    fields[key] = next;
  }
  return { ok: true, fields };
};

export const serializePreferencesDocument = (fields: PreferenceFields) => JSON.stringify({ version: PREFERENCES_DOCUMENT_VERSION, fields }, null, 2);

export const flattenPreferences = (fields: PreferenceFields, surface: SettingsSurface | null = null) => {
  const values: SettingsDocument = {};
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

export const buildPreferencesFields = (previousFields: PreferenceFields, document: SettingsDocument, now: number, { surface = null, changedKeys = null }: PreferencesWriteOptions = {}) => {
  const fields: PreferenceFields = {};
  const changed = changedKeys ? new Set(changedKeys) : null;
  if (surface && changed) {
    for (const [key, previous] of Object.entries(previousFields)) {
      if (isPerSurfaceSettingsKey(key) && !changed.has(key)) fields[key] = previous;
    }
  }
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

export const instancePartOf = (document: SettingsDocument) => {
  const instance: SettingsDocument = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || isProfileSettingsKey(key)) continue;
    instance[key] = value;
  }
  return instance;
};

export const profilePartOf = (document: SettingsDocument) => {
  const profile: SettingsDocument = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined && isProfileSettingsKey(key)) profile[key] = value;
  }
  return profile;
};

export const legacySettingsDocumentOf = (document: SettingsDocument, preferenceFields: PreferenceFields) => ({
  ...instancePartOf(document),
  ...flattenPreferences(preferenceFields),
});

export const seedPreferencesFrom = (document: SettingsDocument, now: number) => buildPreferencesFields({}, document, now);

export const readMergedSettingsSync = ({ fs, path, settingsFilePath }: {
  fs: Pick<typeof fsModule, 'readFileSync'>;
  path: Pick<typeof pathModule, 'join' | 'dirname'>;
  settingsFilePath: string;
}) => {
  let settings: SettingsDocument = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    if (isPlainObject(parsed)) settings = parsed;
  } catch {
    settings = {};
  }
  let preferences: SettingsDocument = {};
  try {
    const parsed = parsePreferencesDocument(fs.readFileSync(preferencesFilePathFor(settingsFilePath, path), 'utf8'));
    if (parsed.ok) preferences = flattenPreferences(parsed.fields);
  } catch {
    preferences = {};
  }
  return { ...settings, ...preferences };
};
