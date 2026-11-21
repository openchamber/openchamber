import { create } from 'zustand';

export type ThemeVariant = 'light' | 'dark';

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
