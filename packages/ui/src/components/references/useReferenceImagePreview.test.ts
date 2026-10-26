import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://openchamber.test/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLImageElement: win.HTMLImageElement,
});

const { imageGalleryAt } = await import('./useReferenceImagePreview');

// happy-dom never loads pixels; a picture marked `loaded` stands for one the browser drew.
const mount = (html: string): HTMLElement => {
  const scope = document.createElement('article');
  scope.innerHTML = html;
  for (const image of Array.from(scope.querySelectorAll('img'))) {
    const width = image.hasAttribute('data-loaded') ? 1920 : 0;
    Object.defineProperty(image, 'naturalWidth', { value: width });
    Object.defineProperty(image, 'complete', { value: true });
  }
  document.body.replaceChildren(scope);
  return scope;
};

const DESCRIPTION = `
  <img src="https://avatars.test/a.png" alt="" data-loaded>
  <div data-markdown-content>
    <p><img src="https://img.test/before.png" alt="Before" data-loaded></p>
    <p><a href="https://ci.test"><img src="https://img.test/badge.svg" alt="CI" data-loaded></a></p>
    <p><img src="https://img.test/broken.png" alt="Broken"></p>
    <p><span><img src="https://icons.test/site.ico" alt="" aria-hidden="true" data-loaded></span><a href="https://site.test">site</a></p>
  </div>
  <div data-markdown-content>
    <p><img src="https://img.test/after.png" alt=" " data-loaded></p>
  </div>
`;

describe('reference image preview', () => {
  test('opens every drawn picture of the item, starting at the clicked one', () => {
    const scope = mount(DESCRIPTION);
    const after = scope.querySelector<HTMLImageElement>('img[src$="after.png"]');

    expect(imageGalleryAt(after, scope)).toEqual({
      url: 'https://img.test/after.png',
      filename: undefined,
      index: 1,
      gallery: [
        { url: 'https://img.test/before.png', filename: 'Before' },
        { url: 'https://img.test/after.png', filename: undefined },
      ],
    });
  });

  test('leaves linked, unloaded, decorative and non-description pictures alone', () => {
    const scope = mount(DESCRIPTION);
    for (const source of ['badge.svg', 'broken.png', 'site.ico', 'a.png']) {
      expect(imageGalleryAt(scope.querySelector(`img[src$="${source}"]`), scope)).toBeNull();
    }
    expect(imageGalleryAt(scope.querySelector('p'), scope)).toBeNull();
  });
});
