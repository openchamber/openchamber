import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { getFileTypeIconHref } from './fileTypeIcons';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });

const spriteRoot = async (): Promise<Element> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const root = document.getElementById('oc-file-type-icon-sprite-root');
    if (root) return root;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the sprite never mounted');
};

// iOS WebKit walks the rendered DOM on every text field focus. Rendered, the
// sprite's thousand internal `<use>` elements added about 150 ms before the
// keyboard could start (performance-engineering, references/ios-webkit.md).
test('the icon sprite stays out of rendering, its paint servers stay reachable', async () => {
  getFileTypeIconHref('index.ts');
  const root = await spriteRoot();
  const [sprite, ...rendered] = Array.from(root.children);

  expect(/display:\s*none/.test(sprite.getAttribute('style') ?? '')).toBe(true);
  expect(sprite.querySelectorAll('linearGradient, radialGradient, clipPath, mask, pattern, filter')).toHaveLength(0);

  // Every `url(#id)` a symbol paints with resolves outside the hidden sprite.
  const referenced = new Set(Array.from(sprite.innerHTML.matchAll(/url\(#([^)]+)\)/g), (match) => match[1]));
  expect(referenced.size).toBeGreaterThan(0);
  const unreachable = Array.from(referenced).filter((id) => {
    const target = document.getElementById(id);
    return !target || sprite.contains(target) || !rendered.some((holder) => holder.contains(target));
  });
  expect(unreachable).toEqual([]);
});
