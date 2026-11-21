import { isMessageSearchEnabled } from './settings-helpers.js';
import type { SettingsDocument, createSettingsHelpers } from './settings-helpers.js';
import type { SettingsRuntimeDependencies } from './settings-runtime.js';
import type { PreferenceFields } from './settings-files.js';
import type { SettingsFileChange, createSettingsFileState } from './settings-file-state.js';
import type { createSettingsWriteQueue } from './settings-write-queue.js';
import {
  flattenPreferences,
  instancePartOf,
  isProfileSettingsKey,
  legacySettingsDocumentOf,
  serializePreferencesDocument,
} from './settings-files.js';

const MANAGED_PLUGIN_SETTINGS_KEYS = new Set([
  'agentControlToolEnabled',
  'agentScheduleToolEnabled',
  'agentWebToolEnabled',
  'agentMemoryToolEnabled',
  'agentKnowledgeToolEnabled',
  'agentNotifyToolEnabled',
  'agentRenderToolEnabled',
  'agentImageToolEnabled',
  'agentSecretToolEnabled',
  'agentUsageToolEnabled',
  'agentTerminalToolEnabled',
  'agentWorkflowToolEnabled',
  'fallbackModel',
  'accountSwitchProviders',
]);

export const createRuntimeSettingsApplier = ({
  onManagedPluginSettingsChanged, onMessageSearchEnabledChanged,
  onMessageSearchReasoningChanged, onPermissionDefaultModeChanged, onLastDirectoryChanged,
}: Required<Pick<SettingsRuntimeDependencies,
  'onManagedPluginSettingsChanged' | 'onMessageSearchEnabledChanged'
  | 'onMessageSearchReasoningChanged' | 'onPermissionDefaultModeChanged' | 'onLastDirectoryChanged'
>>) => async (previous: SettingsDocument, next: SettingsDocument, changedKeys: string[]) => {
  if (changedKeys.some((key) => MANAGED_PLUGIN_SETTINGS_KEYS.has(key))) {
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

export const createExternalSettingsReconciler = ({
  enqueue, settingsFileState, sanitizeSettingsUpdate, writeJsonFileAtomic,
  applyRuntimeSettings, settingsFilePath, preferencesFilePath,
}: {
  enqueue: ReturnType<typeof createSettingsWriteQueue>['enqueue'];
  settingsFileState: ReturnType<typeof createSettingsFileState>;
  sanitizeSettingsUpdate: ReturnType<typeof createSettingsHelpers>['sanitizeSettingsUpdate'];
  writeJsonFileAtomic: (filePath: string, text: string, options: { acknowledge: boolean; expectedRevision: number }) => Promise<void>;
  applyRuntimeSettings: (previous: SettingsDocument, next: SettingsDocument, changedKeys: string[]) => Promise<void>;
  settingsFilePath: string;
  preferencesFilePath: string;
}) => ({ source, changedKeys }: SettingsFileChange): Promise<SettingsFileChange[]> => enqueue(async () => {
  let profileKeys = changedKeys.filter(isProfileSettingsKey);
  const instanceResult = await settingsFileState.read('settings');
  const preferences = await settingsFileState.read('preferences');
  if (instanceResult.status === 'failed' || (profileKeys.length > 0 && preferences.status === 'failed')) {
    throw new Error('External settings reconciliation paused while a settings file is unreadable');
  }
  const instance = instanceResult.document ?? {};
  if (source === 'settings') profileKeys = profileKeys.filter((key) => Object.hasOwn(instance, key));
  const fields: PreferenceFields = structuredClone(preferences.document ?? {});
  const preferenceChanges = preferences.status === 'ok' ? settingsFileState.getPendingChangedKeys('preferences') : [];
  const previousPreferences = settingsFileState.readReported('preferences') ?? {};
  let changed = false;
  if (source === 'settings') {
    const selectionKeys = profileKeys.includes('themeId') && instance.useSystemTheme === false
      ? [...new Set([...profileKeys, 'useSystemTheme'])] : profileKeys;
    const values = sanitizeSettingsUpdate(Object.fromEntries(selectionKeys
      .filter((key) => Object.hasOwn(instance, key)).map((key) => [key, instance[key]])));
    for (const [key, value] of Object.entries(values)) {
      fields[key] = { value, updatedAt: Date.now() };
      changed = true;
    }
  }
  if (!profileKeys.includes('themeId') && profileKeys.some((key) => key === 'lightThemeId' || key === 'darkThemeId')) {
    if (fields.themeId) {
      if (source === 'settings') {
        delete fields.themeId;
        changed = true;
      } else {
        for (const key of profileKeys.filter((key) => key === 'lightThemeId' || key === 'darkThemeId')) {
          if (JSON.stringify(previousPreferences[key]?.value) !== JSON.stringify(fields[key]?.value) && 'value' in fields.themeId) {
            delete fields.themeId.value;
            changed = true;
          }
        }
        if (!('value' in fields.themeId) && Object.keys(fields.themeId.surfaces ?? {}).length === 0) delete fields.themeId;
      }
    }
  }
  if (!preferenceChanges.includes('themeId')) {
    for (const surface of ['desktop', 'web', 'mobile', 'vscode'] as const) {
      const variants = ['lightThemeId', 'darkThemeId'].filter((key) => preferenceChanges.includes(key)
        && fields[key]?.surfaces?.[surface]
        && JSON.stringify(previousPreferences[key]?.surfaces?.[surface]?.value) !== JSON.stringify(fields[key]?.surfaces?.[surface]?.value));
      const selectedKey = variants.length === 1 ? variants[0]
        : variants.find((key) => key === `${fields.themeVariant?.value}ThemeId`);
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
  if (changed) await writeJsonFileAtomic(preferencesFilePath, preferencesText, { acknowledge: false, expectedRevision: preferences.revision ?? 0 });
  if (mirrorChanged) await writeJsonFileAtomic(settingsFilePath, settingsText, { acknowledge: false, expectedRevision: instanceResult.revision ?? 0 });
  const previous = {
    ...instancePartOf(settingsFileState.readReported('settings') ?? {}),
    ...flattenPreferences(settingsFileState.readReported('preferences') ?? {}),
  };
  await applyRuntimeSettings(previous, { ...instancePartOf(instance), ...flattenPreferences(fields) }, [...new Set([...changedKeys, ...preferenceChanges])]);
  if (changed) settingsFileState.acknowledge(preferencesFilePath, preferencesText, { expectedRevision: preferences.revision ?? 0 });
  if (mirrorChanged) settingsFileState.acknowledge(settingsFilePath, settingsText, { expectedRevision: instanceResult.revision ?? 0 });
  return source === 'settings' && preferenceChanges.length > 0
    ? [{ source: 'preferences', changedKeys: preferenceChanges }] : [];
});
