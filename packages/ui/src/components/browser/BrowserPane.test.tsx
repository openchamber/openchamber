import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const browserPaneSource = readFileSync(new URL('./BrowserPane.tsx', import.meta.url), 'utf8');

describe('BrowserPane webview', () => {
  test('emits the Electron popup presence attribute as an empty string', () => {
    expect(/allowpopups:\s*''/.test(browserPaneSource)).toBe(true);

    const markup = renderToStaticMarkup(React.createElement('webview', { allowpopups: '' }));
    expect(markup).toContain('allowpopups=""');
  });
});
