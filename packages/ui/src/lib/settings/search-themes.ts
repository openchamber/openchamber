import type { SettingsSearchItem } from './search';

export const THEME_EDITOR_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  { id: 'theme-editor.base', page: 'theme-editor', titleKey: 'settings.themeEditor.base', keywords: ['theme', 'palette', 'colors'] },
  { id: 'theme-editor.files', page: 'theme-editor', titleKey: 'settings.themeEditor.files', keywords: ['theme', 'save', 'load', 'export', 'json'] },
  { id: 'theme-editor.window', page: 'theme-editor', titleKey: 'settings.themeEditor.window', keywords: ['background', 'transparency', 'opacity'] },
];

export const THEME_PICKER_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'appearance.color-mode',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.section.colorMode',
    keywords: ['theme', 'system', 'light mode', 'dark mode', 'appearance'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.light-theme',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.lightTheme',
    keywords: ['theme', 'color', 'light mode'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.dark-theme',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.darkTheme',
    keywords: ['theme', 'color', 'dark mode'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.import-theme',
    page: 'appearance',
    titleKey: 'settings.themeImport.action',
    descriptionKey: 'settings.themeImport.catalogHint',
    keywords: ['theme', 'import', 'browse', 'catalog', 'vs code', 'vscode', 'open vsx', 'openvsx', 'json', 'jsonc', 'syntax', 'palette'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
];
