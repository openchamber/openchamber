import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { InlineImage } = await import('./InlineImage');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
const lightbox = () => document.body.querySelector('[data-image-lightbox]');

afterAll(async () => {
  await act(async () => root.unmount());
  browser.close();
});

describe('InlineImage', () => {
  const render = (urls: string[]) => act(async () => {
    root.render(
      <I18nProvider>
        <div data-chat-column="main">
          {urls.map((url, index) => <InlineImage key={url} src={url} alt={`image-${index + 1}.png`} />)}
        </div>
      </I18nProvider>,
    );
  });

  test('a click opens the viewer on that image, among every inline image of the chat column', async () => {
    await render(['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']);
    const second = container.querySelectorAll('button')[1];
    await act(async () => second.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(lightbox()?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBBB');
    expect(lightbox()?.textContent).toContain('2 / 2');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(lightbox()).toBeNull();
  });

  test('an image that fails to load is removed and leaves nothing behind', async () => {
    await render(['data:image/png;base64,AAAA']);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    await act(async () => image!.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
