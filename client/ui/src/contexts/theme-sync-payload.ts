import type { Theme } from '@/types/theme';
import { isValidTheme } from './theme-validation';

export type ThemeSyncPayloadShape = {
  currentTheme?: unknown;
};

export const getSyncedThemeFromPayload = (payload: ThemeSyncPayloadShape): Theme | null => (
  isValidTheme(payload.currentTheme) ? payload.currentTheme : null
);

export const getSyncedThemeVariant = (payload: ThemeSyncPayloadShape): 'light' | 'dark' | null => (
  getSyncedThemeFromPayload(payload)?.metadata.variant ?? null
);
