import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/', width: 1280, height: 800 });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
// React DOM reads the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { useFileImageFullscreen } = await import('./useFileImageFullscreen');

type Fullscreen = ReturnType<typeof useFileImageFullscreen>;
type Shown = { path: string | null; image: boolean; svgSource: boolean; visible: boolean };

const IMAGE: Shown = { path: '/p/a.png', image: true, svgSource: false, visible: true };

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;
let latest: Fullscreen | null = null;

function Probe({ shown, isMobile }: { shown: Shown; isMobile: boolean }) {
  const selectedFile = shown.path ? { name: shown.path.split('/').pop() ?? '', path: shown.path, type: 'file' as const } : null;
  latest = useFileImageFullscreen({
    fileKinds: { isSelectedImage: shown.image, isSvgSource: shown.svgSource },
    tabs: { selectedFile },
    isMobile,
    visible: shown.visible,
  });
  return latest.open ? <div ref={latest.closeTabTarget} /> : null;
}

const show = async (shown: Shown, isMobile = false) => {
  if (!reactRoot) {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  }
  await act(async () => reactRoot?.render(<Probe shown={shown} isMobile={isMobile} />));
};

const current = (): Fullscreen => {
  if (!latest) throw new Error('the probe has not rendered');
  return latest;
};

const openIt = async () => {
  await act(async () => current().setOpen(true));
  expect(current().open).toBe(true);
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
  latest = null;
});

describe('useFileImageFullscreen', () => {
  test('an image preview offers it and opens on request', async () => {
    await show(IMAGE);
    expect(current().available).toBe(true);
    expect(current().open).toBe(false);
    await openIt();
  });

  test('hiding the panel closes it, and showing the panel again does not reopen it', async () => {
    await show(IMAGE);
    await openIt();
    await show({ ...IMAGE, visible: false });
    expect(current().open).toBe(false);
    await show(IMAGE);
    expect(current().open).toBe(false);
  });

  test('a step to a file that is not an image closes it for good', async () => {
    await show(IMAGE);
    await openIt();
    await show({ ...IMAGE, path: '/p/notes.md', image: false });
    expect(current().open).toBe(false);
    await show({ ...IMAGE, path: '/p/b.png' });
    expect(current().open).toBe(false);
  });

  test('an SVG switched to source keeps it open, though the button is not offered there', async () => {
    await show({ ...IMAGE, path: '/p/logo.svg' });
    await openIt();
    await show({ ...IMAGE, path: '/p/logo.svg', svgSource: true });
    expect(current().open).toBe(true);
    expect(current().available).toBe(false);
  });

  test('the empty selection a step passes through keeps it open on the next image', async () => {
    await show(IMAGE);
    await openIt();
    await show({ ...IMAGE, path: null, image: false });
    expect(current().open).toBe(true);
    await show({ ...IMAGE, path: '/p/b.png' });
    expect(current().open).toBe(true);
  });

  test('the desktop close-tab event (Electron Ctrl/⌘+W) closes it', async () => {
    await show(IMAGE);
    await openIt();
    await act(async () => { window.dispatchEvent(new Event('openchamber:close-tab')); });
    expect(current().open).toBe(false);
  });

  test('the phone layout does not offer it', async () => {
    browser.happyDOM.setViewport({ width: 390, height: 844 });
    try {
      await show(IMAGE, true);
      expect(current().available).toBe(false);
    } finally {
      browser.happyDOM.setViewport({ width: 1280, height: 800 });
    }
  });
});
