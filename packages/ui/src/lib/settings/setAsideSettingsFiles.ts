import type { DesktopSettings } from '@/lib/desktop';
import { parseSettingsDocument } from '@/lib/settings/registry';

let pending: string[] = [];
const listeners = new Set<() => void>();

const noteSetAsideSettingsFiles = (payload: unknown): void => {
  if (!payload || typeof payload !== 'object' || !('settingsFilesSetAside' in payload)) return;
  const names = Array.isArray(payload.settingsFilesSetAside)
    ? payload.settingsFilesSetAside.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];
  if (names.length === 0) return;
  pending = [...pending, ...names];
  for (const listener of listeners) listener();
};

export const parseServerSettingsPayload = (payload: unknown): DesktopSettings | null => {
  noteSetAsideSettingsFiles(payload);
  return parseSettingsDocument(payload);
};

export const takeSetAsideSettingsFiles = (): string[] => {
  const names = pending;
  pending = [];
  return names;
};

export const subscribeToSetAsideSettingsFiles = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
