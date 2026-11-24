import { isDeepStrictEqual } from 'node:util';
import { isMessageSearchEnabled } from './settings-helpers.js';
import type { SettingsDocument, createSettingsHelpers } from './settings-helpers.js';
import type { SettingsRuntimeDependencies } from './settings-runtime.js';
import type { PreferenceFields } from './settings-files.js';
import { SettingsWriteConflict } from './settings-file-state.js';
import type { SettingsFileChange, createSettingsFileState } from './settings-file-state.js';
import {
  flattenPreferences,
  instancePartOf,
  isProfileSettingsKey,
  legacySettingsDocumentOf,
  serializePreferencesDocument,
} from './settings-files.js';

const MANAGED_PLUGIN_SETTING = /^agent[A-Z]\w*ToolEnabled$/;
const MANAGED_PLUGIN_SETTINGS_KEYS = new Set(['fallbackModel', 'accountSwitchProviders']);

export const createRuntimeSettingsApplier = ({
  onManagedPluginSettingsChanged, onMessageSearchEnabledChanged,
  onMessageSearchReasoningChanged, onPermissionDefaultModeChanged, onLastDirectoryChanged,
}: Required<Pick<SettingsRuntimeDependencies,
  'onManagedPluginSettingsChanged' | 'onMessageSearchEnabledChanged'
  | 'onMessageSearchReasoningChanged' | 'onPermissionDefaultModeChanged' | 'onLastDirectoryChanged'
>>) => async (previous: SettingsDocument, next: SettingsDocument, changedKeys: string[]) => {
  if (changedKeys.some((key) => MANAGED_PLUGIN_SETTING.test(key) || MANAGED_PLUGIN_SETTINGS_KEYS.has(key))) {
    await Promise.resolve(onManagedPluginSettingsChanged(next)).catch((error) => {
      console.warn('Failed to refresh the managed OpenCode config:', error?.message ?? error);
    });
  }
  if (changedKeys.includes('messageSearchEnabled')) onMessageSearchEnabledChanged(isMessageSearchEnabled(next));
  if (changedKeys.includes('messageSearchReasoningEnabled')) onMessageSearchReasoningChanged(next.messageSearchReasoningEnabled === true);
  if (changedKeys.includes('permissionDefaultMode') && next.permissionDefaultMode !== previous.permissionDefaultMode) {
    onPermissionDefaultModeChanged(next.permissionDefaultMode);
  }
  if (changedKeys.includes('lastDirectory') && next.lastDirectory !== previous.lastDirectory) onLastDirectoryChanged(next.lastDirectory);
};

const SNAPSHOT_ATTEMPTS = 3;

export const createExternalSettingsReconciler = ({
  settingsFileState, sanitizeSettingsUpdate, writeJsonFileAtomic,
  applyRuntimeSettings, settingsFilePath, preferencesFilePath,
}: {
  settingsFileState: ReturnType<typeof createSettingsFileState>;
  sanitizeSettingsUpdate: ReturnType<typeof createSettingsHelpers>['sanitizeSettingsUpdate'];
  writeJsonFileAtomic: (filePath: string, text: string, options: { acknowledge: boolean; expectedRevision: number }) => Promise<void>;
  applyRuntimeSettings: (previous: SettingsDocument, next: SettingsDocument, changedKeys: string[]) => Promise<void>;
  settingsFilePath: string;
  preferencesFilePath: string;
}) => {
  const isPaletteKey = (key: string) => key === 'lightThemeId' || key === 'darkThemeId';
  const reconcileSnapshot = async ({ source }: SettingsFileChange): Promise<SettingsFileChange[] | null> => {
    const instanceResult = await settingsFileState.readForWrite('settings');
    const preferences = await settingsFileState.readForWrite('preferences');
    if (instanceResult.status === 'failed') {
      throw new Error('External settings reconciliation paused while a settings file is unreadable');
    }
    const instance = instanceResult.document ?? {};
    const settingsChanges = instanceResult.status === 'ok' ? settingsFileState.getPendingChangedKeys('settings') : [];
    const preferenceChanges = preferences.status === 'ok' ? settingsFileState.getPendingChangedKeys('preferences') : [];
    const profileKeys = settingsChanges.filter((key) => isProfileSettingsKey(key) && Object.hasOwn(instance, key)
      && !isDeepStrictEqual(instance[key], preferences.document?.[key]?.value));
    if (profileKeys.length > 0 && preferences.status === 'failed') {
      throw new Error('External settings reconciliation paused while a settings file is unreadable');
    }
    const fields: PreferenceFields = structuredClone(preferences.document ?? {});
    const previousPreferences = settingsFileState.readReported('preferences') ?? {};
    let changed = false;
    const selectionKeys = profileKeys.includes('themeId') && instance.useSystemTheme === false
      ? [...new Set([...profileKeys, 'useSystemTheme'])] : profileKeys;
    const values = sanitizeSettingsUpdate(Object.fromEntries(selectionKeys
      .filter((key) => Object.hasOwn(instance, key)).map((key) => [key, instance[key]])));
    for (const [key, value] of Object.entries(values)) {
      fields[key] = { value, updatedAt: Date.now() };
      changed = true;
    }
    if (fields.themeId && !profileKeys.includes('themeId') && profileKeys.some(isPaletteKey)) {
      delete fields.themeId;
      changed = true;
    }
    if (fields.themeId && !profileKeys.includes('themeId') && !preferenceChanges.includes('themeId')) {
      for (const key of preferenceChanges.filter(isPaletteKey)) {
        if (JSON.stringify(previousPreferences[key]?.value) !== JSON.stringify(fields[key]?.value) && 'value' in fields.themeId) {
          delete fields.themeId.value;
          changed = true;
        }
      }
      if (!('value' in fields.themeId) && Object.keys(fields.themeId.surfaces ?? {}).length === 0) delete fields.themeId;
    }
    if (!preferenceChanges.includes('themeId')) {
      for (const surface of ['desktop', 'web', 'mobile', 'vscode'] as const) {
        const variants = ['lightThemeId', 'darkThemeId'].filter((key) => preferenceChanges.includes(key)
          && fields[key]?.surfaces?.[surface]
          && JSON.stringify(previousPreferences[key]?.surfaces?.[surface]?.value) !== JSON.stringify(fields[key]?.surfaces?.[surface]?.value));
        const followsSystem = fields.useSystemTheme?.surfaces?.[surface]?.value ?? fields.useSystemTheme?.value;
        const variantKey = `${fields.themeVariant?.value}ThemeId`;
        const selectedKey = followsSystem === false && isPaletteKey(variantKey) ? variants.find((key) => key === variantKey)
          : variants.length === 1 ? variants[0] : variants.find((key) => key === variantKey);
        if (!selectedKey) continue;
        fields.themeId ??= { updatedAt: 0 };
        fields.themeId.surfaces ??= {};
        fields.themeId.surfaces[surface] = { value: fields[selectedKey]?.surfaces?.[surface]?.value, updatedAt: Date.now() };
        changed = true;
      }
    }
    const settingsText = JSON.stringify(preferences.status === 'failed' ? instance : legacySettingsDocumentOf(instance, fields), null, 2);
    const preferencesText = serializePreferencesDocument(fields);
    const mirrorChanged = settingsText !== JSON.stringify(instance, null, 2);
    try {
      if (changed) await writeJsonFileAtomic(preferencesFilePath, preferencesText, { acknowledge: false, expectedRevision: preferences.revision ?? 0 });
      if (mirrorChanged) await writeJsonFileAtomic(settingsFilePath, settingsText, { acknowledge: false, expectedRevision: instanceResult.revision ?? 0 });
    } catch (error) {
      const snapshotMoved = settingsFileState.getRevision('settings') !== (instanceResult.revision ?? 0)
        || settingsFileState.getRevision('preferences') !== (preferences.revision ?? 0);
      if (snapshotMoved) return null;
      throw error;
    }
    const previous = {
      ...instancePartOf(settingsFileState.readReported('settings') ?? {}),
      ...flattenPreferences(settingsFileState.readReported('preferences') ?? {}),
    };
    await applyRuntimeSettings(previous, { ...instancePartOf(instance), ...flattenPreferences(fields) }, [...new Set([...settingsChanges, ...preferenceChanges])]);
    if (changed) settingsFileState.acknowledge(preferencesFilePath, preferencesText, { expectedRevision: preferences.revision ?? 0 });
    if (mirrorChanged) settingsFileState.acknowledge(settingsFilePath, settingsText, { expectedRevision: instanceResult.revision ?? 0 });
    if (instanceResult.status === 'ok') settingsFileState.markReported('settings', instanceResult.revision);
    if (preferences.status === 'ok') settingsFileState.markReported('preferences', preferences.revision);
    const announcements: SettingsFileChange[] = [
      { source: 'settings', changedKeys: settingsChanges },
      { source: 'preferences', changedKeys: preferenceChanges },
    ];
    if (source === 'preferences') announcements.reverse();
    return announcements.filter((announcement) => announcement.changedKeys.length > 0);
  };

  return async (change: SettingsFileChange): Promise<SettingsFileChange[]> => {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const announcements = await reconcileSnapshot(change);
      if (announcements) return announcements;
    }
    throw new SettingsWriteConflict('Settings files kept changing during external reconciliation');
  };
};
