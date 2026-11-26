import type { DesktopSettings } from '@/lib/desktop';

type SettingsKey = keyof DesktopSettings;
type SettingsValue = DesktopSettings[SettingsKey];

const READ_FROM_LEGACY_VALUES: ReadonlySet<SettingsKey> = new Set<SettingsKey>(['activityRenderMode', 'chatRenderMode', 'keepEarlierReplies']);

export const isReadFromLegacyValue = (key: SettingsKey): boolean => READ_FROM_LEGACY_VALUES.has(key);

export const isSameSettingValue = (left: SettingsValue | undefined, right: SettingsValue | undefined): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};
