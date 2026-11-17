import { useUIStore } from '@/stores/useUIStore';
import { isApplyingServerSettings, updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings } from '@/lib/desktop';
import { AUTO_SAVE_KEYS, readAutoSaveSnapshot } from '@/lib/settings/registry';

let initialized = false;

type SettingsValue = DesktopSettings[keyof DesktopSettings];

const isSameValue = (left: SettingsValue, right: SettingsValue): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

export const startAppearanceAutoSave = (): void => {
  if (initialized || globalThis.window === undefined) {
    return;
  }

  initialized = true;

  let previous = readAutoSaveSnapshot();

  useUIStore.subscribe(() => {
    const current = readAutoSaveSnapshot();

    if (isApplyingServerSettings()) {
      previous = current;
      return;
    }

    const diff: DesktopSettings = {};
    for (const key of AUTO_SAVE_KEYS) {
      if (isSameValue(current[key], previous[key])) continue;
      Object.assign(diff, { [key]: current[key] });
    }

    previous = current;

    if (Object.keys(diff).length > 0) {
      void updateDesktopSettings(diff);
    }
  });
};
