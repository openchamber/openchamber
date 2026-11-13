import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

import type { DesktopQuakeMode } from './useDesktopQuakeMode';

mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (value: { shortcutOverrides: Record<string, string>; setShortcutOverride: () => void }) => T): T => (
    selector({ shortcutOverrides: {}, setShortcutOverride: () => undefined })
  ),
}));

const { DesktopQuakeModeSettings } = await import('./DesktopQuakeModeSettings');

const quake = (heightFraction: number): DesktopQuakeMode => ({
  supported: true,
  enabled: true,
  active: true,
  combo: null,
  storedCombo: null,
  heightFraction,
  isSaving: false,
  setEnabled: () => undefined,
  setHeight: () => undefined,
  saveShortcut: async () => true,
  release: () => undefined,
});

const triggerText = (heightFraction: number): string => {
  const markup = renderToStaticMarkup(
    <I18nProvider>
      <DesktopQuakeModeSettings quake={quake(heightFraction)} miniChatCombo={null} onReleaseMiniChatShortcut={() => undefined} />
    </I18nProvider>,
  );
  const trigger = /<button[^>]*aria-label="Quake window height"[^>]*>([\s\S]*?)<\/button>/.exec(markup)?.[1] ?? '';
  return trigger.replace(/<[^>]+>/g, '');
};

describe('Quake window height', () => {
  test('the trigger shows the selected option as a percentage, like the list', () => {
    expect(triggerText(0.6)).toBe('60%');
    expect(triggerText(0.33)).toBe('35%');
  });
});
