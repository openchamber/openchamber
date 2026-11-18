import type fs from 'node:fs';
import type path from 'node:path';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

export type SettingsSurface = 'web' | 'desktop' | 'vscode' | 'mobile';

export interface PreferenceField {
  value?: JsonValue;
  updatedAt: number;
  surfaces?: Partial<Record<SettingsSurface, { value: JsonValue; updatedAt: number }>>;
}

export type PreferenceFields = Record<string, PreferenceField>;

export function isProfileSettingsKey(key: string): boolean;
export function isDeviceSettingsKey(key: string): boolean;
export function normalizeSettingsSurface(value: unknown): SettingsSurface | null;
export function settingsSurfaceOf(request: {
  query?: import('../shared/http-contracts.js').Query;
  get?(header: string): string | string[] | undefined;
}): SettingsSurface | null;
export function preferencesFilePathFor(settingsFilePath: string, pathModule: Pick<typeof path, 'join' | 'dirname'>): string;
export function parsePreferencesDocument(raw: string):
  | { ok: false; reason: string }
  | { ok: true; fields: PreferenceFields };
export function serializePreferencesDocument(fields: PreferenceFields): string;
export function flattenPreferences(fields: PreferenceFields, surface?: SettingsSurface | null): JsonObject;
export function buildPreferencesFields(
  previousFields: PreferenceFields,
  document: JsonObject,
  now: number,
  options?: { surface?: SettingsSurface | null; changedKeys?: Iterable<string> | null },
): PreferenceFields;
export function instancePartOf(document: JsonObject): JsonObject;
export function profilePartOf(document: JsonObject): JsonObject;
export function legacySettingsDocumentOf(document: JsonObject, preferenceFields: PreferenceFields): JsonObject;
export function seedPreferencesFrom(document: JsonObject, now: number): PreferenceFields;
export function readMergedSettingsSync(options: {
  fs: Pick<typeof fs, 'readFileSync'>;
  path: Pick<typeof path, 'join' | 'dirname'>;
  settingsFilePath: string;
}): JsonObject;
