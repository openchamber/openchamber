import { SEMANTIC_TYPOGRAPHY, getTypographyVariable } from '@/lib/typography';
import type { SemanticTypographyKey } from '@/lib/typography';
import type { UIStoreSlice } from './types';

export const createAppearanceActions: UIStoreSlice<
  | 'setTheme'
  | 'setFontSize'
  | 'setChatFontSize'
  | 'setTerminalFontSize'
  | 'setEditorFontSize'
  | 'setUiFont'
  | 'setMonoFont'
  | 'setCustomUiFont'
  | 'setCustomMonoFont'
  | 'setUiFontWeight'
  | 'setPadding'
  | 'setCornerRadius'
  | 'applyTypography'
  | 'applyPadding'
  | 'applyTheme'
> = (set, get) => ({
  setTheme: (theme) => {
    set({ theme });
    get().applyTheme();
  },

  setFontSize: (size) => {
    const clampedSize = Math.max(50, Math.min(200, size));
    set({ fontSize: clampedSize });
    get().applyTypography();
  },

  setChatFontSize: (size) => {
    set({ chatFontSize: Math.max(50, Math.min(200, Math.round(size))) });
  },

  setTerminalFontSize: (size) => {
    const rounded = Math.round(size);
    const clamped = Math.max(9, Math.min(52, rounded));
    set({ terminalFontSize: clamped });
  },

  setEditorFontSize: (size) => {
    const rounded = Math.round(size);
    const clamped = Math.max(9, Math.min(32, rounded));
    set({ editorFontSize: clamped });
  },

  setUiFont: (font) => {
    set({ uiFont: font });
  },

  setMonoFont: (font) => {
    set({ monoFont: font });
  },

  setCustomUiFont: (family) => {
    set({ customUiFont: family.slice(0, 100) });
  },

  setCustomMonoFont: (family) => {
    set({ customMonoFont: family.slice(0, 100) });
  },

  setUiFontWeight: (weight) => {
    set({ uiFontWeight: weight });
  },

  setPadding: (size) => {
    const clampedSize = Math.max(50, Math.min(200, size));
    set({ padding: clampedSize });
    get().applyPadding();
  },

  setCornerRadius: (radius) => {
    set({ cornerRadius: radius });
  },

  applyTypography: () => {
    const { fontSize } = get();
    const root = document.documentElement;

    const scale = fontSize / 100;

    const entries = Object.entries(SEMANTIC_TYPOGRAPHY) as Array<[SemanticTypographyKey, string]>;

    if (scale === 1) {
      root.style.removeProperty('font-size');
      for (const [key] of entries) {
        root.style.removeProperty(getTypographyVariable(key));
      }
      return;
    }

    root.style.fontSize = `${scale * 100}%`;

    for (const [key] of entries) root.style.removeProperty(getTypographyVariable(key));
  },

  applyPadding: () => {
    const { padding } = get();
    const root = document.documentElement;

    const scale = padding / 100;

    if (scale === 1) {
      root.style.removeProperty('--padding-scale');
      root.style.removeProperty('--line-height-tight');
      root.style.removeProperty('--line-height-normal');
      root.style.removeProperty('--line-height-relaxed');
      root.style.removeProperty('--line-height-loose');
      return;
    }

    const adjustedScale = Math.sqrt(scale);

    root.style.setProperty('--padding-scale', adjustedScale.toString());

    const lineHeightScale = 1 + (scale - 1) * 0.15;

    root.style.setProperty('--line-height-tight', (1.25 * lineHeightScale).toFixed(3));
    root.style.setProperty('--line-height-normal', (1.5 * lineHeightScale).toFixed(3));
    root.style.setProperty('--line-height-relaxed', (1.625 * lineHeightScale).toFixed(3));
    root.style.setProperty('--line-height-loose', (2 * lineHeightScale).toFixed(3));
  },

  applyTheme: () => {
    const { theme } = get();
    const root = document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  },
});
