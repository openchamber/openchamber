import React from 'react';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { getMonoFontStack, getUiFontStack } from '@/lib/fontOptions';
import { loadMonoFont, loadUiFont } from '@/lib/fontLoader';

export function useAppFontEffects() {
  const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const uiStack = getUiFontStack(uiFont, customUiFont);
    const monoStack = getMonoFontStack(monoFont, customMonoFont);
    void loadUiFont(uiFont);
    void loadMonoFont(monoFont);

    root.style.setProperty('--font-sans', uiStack);
    root.style.setProperty('--font-heading', uiStack);
    root.style.setProperty('--font-family-sans', uiStack);
    root.style.setProperty('--font-mono', monoStack);
    root.style.setProperty('--font-family-mono', monoStack);
    root.style.setProperty('--ui-regular-font-weight', '400');

    if (document.body) {
      document.body.style.fontFamily = uiStack;
    }
  }, [uiFont, monoFont, customUiFont, customMonoFont]);
}
