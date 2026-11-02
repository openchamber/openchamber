import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';
import { UiBlock } from './UiBlock';

test('invalid UI starts collapsed, reveals its cause and source, and clears on corrected output', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const theme = getDefaultTheme(false);
  const context: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (source: string) => act(async () => {
    root.render(<I18nProvider><ThemeSystemContext.Provider value={context}><UiBlock source={source} complete /></ThemeSystemContext.Provider></I18nProvider>);
  });
  try {
    const source = 'root = Stack([missing])';
    await render(source);
    expect(host.querySelector('pre')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => host.querySelector('button')?.click());
    expect(host.querySelector('pre')?.textContent).toBe(`Undefined names: missing\n\n${source}`);
    await act(async () => host.querySelector('button')?.click());
    expect(host.querySelector('pre')).toBeNull();
    await render('root = Stack([Badge("Corrected", "success")])');
    expect(host.textContent).toContain('Corrected');
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  }
});
