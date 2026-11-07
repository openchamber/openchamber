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
const { useUIStore } = await import('@/stores/useUIStore');
const { ImageLightbox } = await import('./ImageLightbox');
const { FIT_VIEW, zoomViewAt } = await import('./imageView');

describe('zoomViewAt', () => {
  const origin = { left: 100, top: 50 };

  test('keeps the image point under the cursor fixed', () => {
    const view = zoomViewAt(FIT_VIEW, 4, 300, 250, origin);
    // The point under the cursor, in unscaled image coordinates, before and after.
    expect((300 - origin.left - FIT_VIEW.x) / FIT_VIEW.scale).toBeCloseTo((300 - origin.left - view.x) / view.scale);
    expect((250 - origin.top - FIT_VIEW.y) / FIT_VIEW.scale).toBeCloseTo((250 - origin.top - view.y) / view.scale);
    expect(view.scale).toBe(4);
  });

  test('keeps it fixed when already zoomed and panned', () => {
    const zoomed = { scale: 2, x: -40, y: 30 };
    const view = zoomViewAt(zoomed, 5, 420, 180, origin);
    expect((420 - origin.left - zoomed.x) / zoomed.scale).toBeCloseTo((420 - origin.left - view.x) / view.scale);
    expect((180 - origin.top - zoomed.y) / zoomed.scale).toBeCloseTo((180 - origin.top - view.y) / view.scale);
  });

  test('never zooms out past fit, and fit drops the pan', () => {
    expect(zoomViewAt({ scale: 3, x: -80, y: 20 }, 0.4, 10, 10, origin)).toEqual(FIT_VIEW);
  });

  test('stops at the largest zoom', () => {
    expect(zoomViewAt(FIT_VIEW, 500, 100, 100, origin).scale).toBe(12);
  });
});

describe('ImageLightbox', () => {
  const images = [
    { src: 'data:image/png;base64,AAAA', alt: 'first.png' },
    { src: 'data:image/png;base64,BBBB', alt: 'second.png' },
    { src: 'data:image/png;base64,CCCC', alt: 'third.png' },
  ];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = 0;
  let opened = 0;
  const overlay = () => document.body.querySelector('[data-image-lightbox]');
  const shownSrc = () => overlay()?.querySelector('img')?.getAttribute('src');
  const key = async (name: string) => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  };
  const open = async (list = images, initialIndex = 0) => {
    closed = 0;
    opened += 1;
    await act(async () => {
      root.render(<I18nProvider><ImageLightbox key={opened} images={list} initialIndex={initialIndex} onClose={() => { closed += 1; }} /></I18nProvider>);
    });
  };

  afterAll(async () => {
    await act(async () => root.unmount());
    browser.close();
  });

  test('portals to the body, shows the counter and holds the app shortcuts off', async () => {
    await open(images, 1);
    expect(overlay()?.parentElement).toBe(document.body);
    expect(shownSrc()).toBe(images[1].src);
    expect(overlay()?.textContent).toContain('2 / 3');
    expect(useUIStore.getState().isImagePreviewOpen).toBe(true);
  });

  test('the arrow keys page through the images and wrap around', async () => {
    await open(images, 0);
    await key('ArrowRight');
    expect(shownSrc()).toBe(images[1].src);
    await key('ArrowLeft');
    await key('ArrowLeft');
    expect(shownSrc()).toBe(images[2].src);
    expect(overlay()?.textContent).toContain('3 / 3');
  });

  test('Escape closes the viewer and the key does not reach the app', async () => {
    await open();
    let leaked = 0;
    const onApp = () => { leaked += 1; };
    window.addEventListener('keydown', onApp);
    await key('Escape');
    await key('ArrowRight');
    window.removeEventListener('keydown', onApp);
    expect(closed).toBe(1);
    expect(leaked).toBe(0);
  });

  test('a click on the backdrop closes it, a click on the image does not', async () => {
    await open();
    await act(async () => {
      overlay()?.querySelector('img')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(closed).toBe(0);
    await act(async () => {
      overlay()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(closed).toBe(1);
  });

  test('a single image has no paging controls', async () => {
    await open([images[0]]);
    expect(overlay()?.querySelectorAll('button')).toHaveLength(1);
    expect(overlay()?.textContent).not.toContain('/');
  });

  test('unmounting releases the app shortcuts', async () => {
    await open();
    await act(async () => root.render(null));
    expect(overlay()).toBeNull();
    expect(useUIStore.getState().isImagePreviewOpen).toBe(false);
  });
});
