// The two settings files and how a merged document is split between them.
//
// `settings.json` holds instance facts (and, untouched, whatever legacy keys
// older builds left there). `preferences.json` holds the user's profile: the
// keys the settings registry marks `profile`, each with the time the store
// last accepted a new value for it. Device keys never reach either file.
//
// Mirrors the server implementation in
// `packages/web/server/lib/opencode/settings-files.js`; both sides must write
// byte-compatible files, so keep format changes in sync.
//
// Kept free of `vscode` imports so it is unit-tested directly.
import * as path from 'path';
import { SETTINGS_REGISTRY_FIELDS } from './settings-registry-gate';

const PREFERENCES_FILE_NAME = 'preferences.json';
const PREFERENCES_DOCUMENT_VERSION = 1;

type SettingsSurface = 'web' | 'desktop' | 'vscode' | 'mobile';
const SETTINGS_SURFACES: readonly SettingsSurface[] = ['web', 'desktop', 'vscode', 'mobile'];
// SAFETY: widening the tuple to `readonly string[]` only for the membership test; the guard's result is what narrows.
const isSettingsSurface = (value: string): value is SettingsSurface => (SETTINGS_SURFACES as readonly string[]).includes(value);

/** The extension host is always the VS Code surface kind. */
export const VSCODE_SETTINGS_SURFACE: SettingsSurface = 'vscode';

// Boundary parser: values are whatever JSON the file (or the webview) carries.
type SurfaceValue = { value: unknown; updatedAt: number };
// The base value is optional: a per-surface key first set from one surface kind has none.
type PreferenceField = { value?: unknown; updatedAt: number; surfaces?: Partial<Record<SettingsSurface, SurfaceValue>> };
export type PreferenceFields = Record<string, PreferenceField>;

type ParsedPreferencesDocument =
  | { ok: true; fields: PreferenceFields }
  | { ok: false; reason: string };

/** The registry scope for a key, or `null` when the registry does not know it. */
const getSettingsScope = (key: string): string | null =>
  Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY_FIELDS, key) ? SETTINGS_REGISTRY_FIELDS[key].scope : null;

export const isProfileSettingsKey = (key: string): boolean => getSettingsScope(key) === 'profile';
export const isDeviceSettingsKey = (key: string): boolean => getSettingsScope(key) === 'device';
/** Profile keys the owner chose to store per surface kind. */
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

/**
 * Parse the text of a preferences file. A missing file is the caller's case
 * (ENOENT); anything that is not a version-1 document with a `fields` object
 * is a failure, never an empty profile.
 */
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

/**
 * The plain key → value view of preference fields as one surface kind sees it:
 * that surface's own value first, the base value otherwise; a key with neither
 * is absent (the webview keeps what it holds, or its default).
 */
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

/**
 * The next preference fields for a merged document: every profile key it
 * carries, stamped `now` when its value differs from what the file held and
 * keeping the earlier stamp otherwise. Profile keys the document no longer
 * carries are dropped (that is how a cleared key leaves the file).
 */
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
    // Per-surface keys: a surface's write lands under its own entry and leaves
    // the base as it was; a key the write did not change keeps its whole entry
    // (the document only carries this surface's resolved view of it).
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
  return fields;
};

/**
 * The part of a merged document that belongs in `settings.json`: everything
 * that is not a profile key. Device keys are already filtered by the registry
 * gate on the write path; ones older builds persisted stay in place.
 */
export const instancePartOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const instance: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || isProfileSettingsKey(key)) continue;
    instance[key] = value;
  }
  return instance;
};

/** The profile keys of a document, as they would seed a fresh preferences file. */
/** The profile keys of a document (the part `instancePartOf` leaves out). */
export const profilePartOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const profile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined && isProfileSettingsKey(key)) profile[key] = value;
  }
  return profile;
};

/**
 * What `settings.json` holds after a write: the instance part plus a copy of
 * the profile's base values, so a build from before the split (which reads
 * only this file) still finds the user's preferences. Current builds ignore
 * the copy: `preferences.json` wins in the merged read.
 */
export const legacySettingsDocumentOf = (
  document: Record<string, unknown>,
  preferenceFields: PreferenceFields,
): Record<string, unknown> => ({
  ...instancePartOf(document),
  ...flattenPreferences(preferenceFields),
});

export const seedPreferencesFrom = (document: Record<string, unknown>, now: number): PreferenceFields =>
  buildPreferencesFields({}, document, now);
