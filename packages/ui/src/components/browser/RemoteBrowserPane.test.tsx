import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { RemoteBrowserPane } from './RemoteBrowserPane';

describe('RemoteBrowserPane', () => {
  test('renders the localized loading state before the surface connects', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <RemoteBrowserPane directory="/project" tabID="browser:server:test" />
      </I18nProvider>,
    );

    expect(markup).toContain('Connecting to the server browser…');
    expect(markup).toContain('aria-label="Remote page view"');
  });
});
