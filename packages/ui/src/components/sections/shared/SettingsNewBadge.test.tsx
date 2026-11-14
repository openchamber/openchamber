import React from 'react';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { resetNewSettingsBadgeCacheForTests } from '@/lib/settings/newSettings';
import { SETTINGS_ANCHOR_PAGES, type SettingsSearchAvailabilityContext } from '@/lib/settings/search';
import {
  SettingsAvailabilityProvider,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsNewBadge,
  SettingsSection,
  SettingsStackedField,
} from './SettingsSection';

const STORAGE_KEY = 'openchamber.settings.newBadgeSeen.v1';
const previousLocalStorage = globalThis.localStorage;

beforeAll(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
    },
    configurable: true,
    writable: true,
  });
  // A client that last saw the build before these two controls existed.
  const known = [...SETTINGS_ANCHOR_PAGES.keys()].filter((id) => id !== 'notifications.pullRequests' && id !== 'appearance.color-mode');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(known));
  resetNewSettingsBadgeCacheForTests();
});

afterAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: previousLocalStorage, configurable: true, writable: true });
  resetNewSettingsBadgeCacheForTests();
});

const WEB: SettingsSearchAvailabilityContext = {
  isVSCode: false, isWeb: true, isDesktop: false, isMobile: false,
  isDesktopLocalOrigin: false, isMac: false, isWindows: false, isLinux: false,
  routingAvailable: false, enterpriseMode: false, jevBlockedByEnterprise: false,
};

const render = (node: React.ReactNode, ctx: SettingsSearchAvailabilityContext | null = WEB) => renderToStaticMarkup(
  <I18nProvider>
    {ctx ? <SettingsAvailabilityProvider value={ctx}>{node}</SettingsAvailabilityProvider> : node}
  </I18nProvider>,
);

describe('rows announce their own new control', () => {
  test('a new anchor carries the badge, a known one does not', () => {
    const noop = () => {};
    expect(render(<SettingsCheckboxRow settingsItem="notifications.pullRequests" checked={false} onChange={noop} label="PR" />)).toContain('>new<');
    expect(render(<SettingsSection title="Mode" settingsItem="appearance.color-mode">x</SettingsSection>)).toContain('>new<');
    expect(render(<SettingsCheckboxRow settingsItem="appearance.language" checked={false} onChange={noop} label="L" />)).not.toContain('>new<');
    expect(render(<SettingsFieldRow label="K" settingsItem="appearance.file-editor-keymap">x</SettingsFieldRow>)).not.toContain('>new<');
    expect(render(<SettingsStackedField label="S">x</SettingsStackedField>)).not.toContain('>new<');
  });

  test('an opener announces only controls this device renders, and nothing shows outside Settings', () => {
    const opener = <SettingsNewBadge items={['notifications.events', 'notifications.pullRequests']} />;
    expect(render(opener)).toContain('>new<');
    // VS Code has no pull-request notifications.
    expect(render(opener, { ...WEB, isVSCode: true, isWeb: false })).not.toContain('>new<');
    expect(render(opener, null)).not.toContain('>new<');
  });
});
