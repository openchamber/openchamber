import { create } from 'zustand';

export type ThemeVariant = 'light' | 'dark';

/**
 * The Light / Dark tab of the Appearance theme list. It lives outside the page
 * so a Settings search result for the light or dark theme can open its tab
 * before the page highlights it. `null` until the user or a search picks a
 * tab; the page then follows the color mode.
 */
export const useThemeVariantTabStore = create<{
  variant: ThemeVariant | null;
  setVariant: (variant: ThemeVariant) => void;
}>((set) => ({
  variant: null,
  setVariant: (variant) => set({ variant }),
}));

export const themeVariantForSearchTarget = (id: string): ThemeVariant | null => {
  if (id === 'appearance.light-theme') return 'light';
  if (id === 'appearance.dark-theme') return 'dark';
  return null;
};
