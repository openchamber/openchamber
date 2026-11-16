import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

import { BrowserEngineSelect } from './BrowserEngineSelect';
import { SERVER_BROWSER_GUEST_ID } from './serverBrowserApi';

// `renderToStaticMarkup` makes React read a zustand hook's `getServerSnapshot`,
// which zustand wires to `getInitialState()` rather than the live `getState()`
// — the same reason GitHubSettings.test.tsx mutates its store's initial-state
// object directly instead of calling `setState`.
const initialState = useUIStore.getInitialState();
const initialBrowserProvider = initialState.browserProvider;

const renderSelect = () => renderToStaticMarkup(
  <I18nProvider>
    <BrowserEngineSelect />
  </I18nProvider>,
);

describe('BrowserEngineSelect', () => {
  afterEach(() => {
    Object.assign(initialState, { browserProvider: initialBrowserProvider });
  });

  test('shows Server as the default, unset value', () => {
    Object.assign(initialState, { browserProvider: SERVER_BROWSER_GUEST_ID });
    const markup = renderSelect();
    expect(markup).toContain('Server (Chrome on the OpenChamber server)');
  });

  test('shows OpenChamber Web once the user picked the in-app browser', () => {
    Object.assign(initialState, { browserProvider: 'builtin' });
    const markup = renderSelect();
    expect(markup).toContain('OpenChamber Web');
    expect(markup).toContain('value="builtin"');
  });

  test('falls back to Server when the saved value names a gone extension', () => {
    Object.assign(initialState, { browserProvider: 'some-removed-extension' });
    const markup = renderSelect();
    expect(markup).toContain('Server (Chrome on the OpenChamber server)');
  });
});
