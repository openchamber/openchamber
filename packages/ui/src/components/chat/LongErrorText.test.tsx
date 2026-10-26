import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { LongErrorText } from './LongErrorText';
import { getLongErrorPreview } from './longErrorPreview';

const renderError = (text: string) => renderToStaticMarkup(
  <I18nProvider>
    <LongErrorText text={text}>
      {(visibleText) => <p data-visible-length={visibleText.length}>{visibleText}</p>}
    </LongErrorText>
  </I18nProvider>,
);

describe('getLongErrorPreview', () => {
  test('keeps a short error whole', () => {
    expect(getLongErrorPreview('Unexpected end of JSON input')).toBeNull();
    expect(getLongErrorPreview('x'.repeat(1_000))).toBeNull();
  });

  test('cuts a long single-line error to its first characters', () => {
    const preview = getLongErrorPreview(`JSON parsing failed: ${'{"a":1}'.repeat(30_000)}`);
    expect(preview?.startsWith('JSON parsing failed: ')).toBe(true);
    expect(preview?.endsWith('…')).toBe(true);
    expect(preview?.length).toBeLessThanOrEqual(401);
  });

  test('cuts a long multi-line error to its first lines', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const preview = getLongErrorPreview(lines.join('\n'));
    expect(preview).toBe(`${lines.slice(0, 6).join('\n')}…`);
  });

  test('does not split an emoji at the cut', () => {
    const preview = getLongErrorPreview(`${'a'.repeat(399)}😀${'b'.repeat(2_000)}`);
    expect(preview).toBe(`${'a'.repeat(399)}…`);
  });
});

describe('LongErrorText', () => {
  test('shows a short error in full with no button', () => {
    const markup = renderError('Model unavailable');
    expect(markup).toBe('<p data-visible-length="17">Model unavailable</p>');
  });

  test('starts a long error collapsed, without rendering the full text', () => {
    const text = `Opencode failed to send message with error: ${'x'.repeat(200_000)}`;
    const markup = renderError(text);
    expect(markup).not.toContain('x'.repeat(1_000));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('>Show full error</button>');
  });
});

describe('LongErrorText interaction', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
  });

  const render = async (text: string) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <LongErrorText text={text}>{(visibleText) => <p>{visibleText}</p>}</LongErrorText>
        </I18nProvider>,
      );
    });
  };

  const toggle = () => host.querySelector('button');
  const click = async () => {
    await act(async () => toggle()?.click());
  };

  test('expands to the full text and collapses back', async () => {
    const text = `first error ${'x'.repeat(5_000)}`;
    await render(text);
    expect(host.querySelector('p')?.textContent).not.toBe(text);

    await click();
    expect(host.querySelector('p')?.textContent).toBe(text);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.textContent).toBe('Show less');

    await click();
    expect(host.querySelector('p')?.textContent).not.toBe(text);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  test('a different error in the same place starts collapsed', async () => {
    await render(`first error ${'x'.repeat(5_000)}`);
    await click();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');

    await render(`second error ${'y'.repeat(5_000)}`);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle()?.textContent).toBe('Show full error');
  });
});
