import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import { StatusImage } from './status-image';

test('thumbnail and large images preserve native image dragging', () => {
  for (const variant of ['thumbnail', 'large'] as const) {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <StatusImage src="data:image/png;base64,AA==" alt="Attachment" variant={variant} />
      </I18nProvider>,
    );

    expect(markup).toContain('<img');
    expect(markup).not.toContain('draggable=');
  }
});
