import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nContext, type I18nContextValue } from '@/lib/i18n/react-context';
import { dict } from '@/lib/i18n/messages/en';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { JsonTreeView } = await import('./JsonTreeView');
const i18n: I18nContextValue = {
  locale: 'en',
  direction: 'ltr',
  locales: ['en'],
  setLocale: () => {},
  label: (locale) => locale,
  t: (key) => dict[key],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => browser.close());

async function render(jsonString: string, format?: 'json' | 'jsonc') {
  await act(async () => {
    root.render(
      <I18nContext.Provider value={i18n}>
        <JsonTreeView jsonString={jsonString} format={format} />
      </I18nContext.Provider>,
    );
  });
}

const invalidTitle = dict['jsonTreeView.error.invalidJsonTitle'];
const expandLabel = dict['jsonTreeView.actions.expandAll'];

describe('JsonTreeView parsing', () => {
  test('accepts JSONC comments and trailing commas while preserving strings', async () => {
    const literal = 'https://example.com /* text */ ,} ,] "quoted"';
    await render(`{// comment\n"value": /* comment */ ${JSON.stringify(literal)}, "items": [1,],}`, 'jsonc');
    expect(container.textContent).toContain(literal);
    expect(container.textContent).not.toContain(invalidTitle);
  });

  test('reparses unchanged content when switching to default strict JSON', async () => {
    const source = '{"enabled": true,}';
    await render(source, 'jsonc');
    expect(container.textContent).toContain(expandLabel);
    await render(source);
    expect(container.textContent).toContain(invalidTitle);
    expect(container.textContent).not.toContain(expandLabel);
  });

  test('reports malformed JSONC and recovers after correcting the content', async () => {
    await render('{"enabled": }', 'jsonc');
    expect(container.textContent).toContain(invalidTitle);
    await render('{"enabled": true}', 'jsonc');
    expect(container.textContent).toContain('"enabled"');
    expect(container.textContent).toContain('true');
    expect(container.textContent).not.toContain(invalidTitle);
  });
});
