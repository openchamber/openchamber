import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { buildSettingsSearchResults } from '@/lib/settings/search';
import { settingsLayoutI18n } from '@/lib/i18n/messages/settings-layout.i18n';
import { MobileAppSettings } from './MobileAppSettings';

const runtimeCtx = {
  isVSCode: false, isWeb: true, isDesktop: false, isMobile: true,
  isDesktopLocalOrigin: false, isMac: false, isWindows: false, isLinux: false,
  routingAvailable: false, enterpriseMode: false, jevBlockedByEnterprise: false,
};

describe('native mobile Settings', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let restore: () => void;

  beforeEach(() => {
    windowInstance = new Window();
    const globals = {
      window: windowInstance, document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement, Element: windowInstance.Element, Node: windowInstance.Node,
      ResizeObserver: windowInstance.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    Object.assign(globalThis, globals);
    restore = () => {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    useUIStore.getState().setMobileScreenAwakeMode('off');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useUIStore.getState().setMobileScreenAwakeMode('off');
    windowInstance.close();
    restore();
  });

  test('the three choices apply immediately and expose their selected state', async () => {
    await act(async () => root.render(<I18nProvider><TooltipProvider><MobileAppSettings /></TooltipProvider></I18nProvider>));
    const anchor = host.querySelector('[data-settings-item="general.mobile-screen-awake"]');
    expect(anchor).not.toBeNull();
    const buttons = anchor?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]');
    expect(buttons?.length).toBe(3);
    for (const [index, mode] of ['off', 'working', 'always'].entries()) {
      const button = buttons?.[index];
      if (!button) throw new Error('Missing screen-awake option');
      await act(async () => button.click());
      expect(useUIStore.getState().mobileScreenAwakeMode).toBe(mode);
      expect(button.getAttribute('aria-pressed')).toBe('true');
    }
    expect(host.textContent).toContain('more battery');
  });

  test('search exposes the control in native Android/iOS only, not hosted mobile or other runtimes', () => {
    const find = () => buildSettingsSearchResults({ query: 'screen awake', runtimeCtx, t: (key) => key, getPageTitle: (page) => page })
      .some((result) => result.id === 'general.mobile-screen-awake');
    expect(find()).toBe(false);
    Object.defineProperty(windowInstance, 'Capacitor', { value: { isNativePlatform: () => true }, configurable: true });
    expect(find()).toBe(true);
    Reflect.deleteProperty(windowInstance, 'Capacitor');
    expect(find()).toBe(false);
  });

  test('every shipped locale translates the setting, explanation and error', () => {
    for (const messages of Object.values(settingsLayoutI18n)) {
      for (const key of ['settings.mobile.title', 'settings.mobile.screenAwake.label', 'settings.mobile.screenAwake.info', 'settings.mobile.screenAwake.off', 'settings.mobile.screenAwake.working', 'settings.mobile.screenAwake.always', 'settings.mobile.screenAwake.battery', 'settings.mobile.screenAwake.error'] as const) {
        expect(messages[key].length > 0).toBe(true);
      }
      expect(messages['settings.mobile.screenAwake.info']).not.toBe('settings.mobile.screenAwake.info');
    }
  });
});
