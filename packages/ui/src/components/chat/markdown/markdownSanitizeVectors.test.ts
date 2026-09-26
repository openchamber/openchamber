import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

// DOMPurify binds to the global window at import time, so a real DOM must exist
// before markdownCore is loaded. Unlike markdownCore.test.ts, which mocks
// DOMPurify to test the href hooks, this suite runs the real pipeline: the
// sanitizer config itself is the unit under test.
const testWindow = new Window();
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  HTMLAnchorElement: testWindow.HTMLAnchorElement,
});

const { __sanitizeForTests } = await import('./markdownCore');

describe('markdown sanitizer XSS vectors', () => {
  test('strips event handlers from SVG elements but keeps legitimate shapes', () => {
    const html = __sanitizeForTests('<svg onload="alert(1)"><circle r="1" onload="alert(1)"/></svg>');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('alert(1)');
    // Positive control: the SVG allowlist still renders shapes.
    expect(html).toContain('<svg');
    expect(html).toContain('<circle');
  });

  test('strips SMIL animation event handlers', () => {
    const html = __sanitizeForTests('<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"/></svg>');
    expect(html).not.toContain('onbegin');
    expect(html).not.toContain('alert(1)');
  });

  test('removes script tags and their content inside SVG', () => {
    // happy-dom's parser drops SVG children that follow a leading <script> or
    // <style>, so the legitimate shape is placed first; real browsers parse
    // either order correctly.
    const html = __sanitizeForTests('<svg><circle r="1"/><script>alert(1)</script></svg>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('<circle');
  });

  test('removes style tags inside SVG', () => {
    const html = __sanitizeForTests('<svg><circle r="1"/><style>*{display:none}</style></svg>');
    expect(html).not.toContain('<style');
    expect(html).toContain('<circle');
  });

  test('strips javascript: URLs from anchor hrefs', () => {
    const html = __sanitizeForTests('<a href="javascript:alert(1)">link</a>');
    expect(html).not.toContain('javascript:');
  });

  test('strips event handlers from standard HTML elements', () => {
    const html = __sanitizeForTests('<img src="x" onerror="alert(1)"><b onclick="alert(1)">bold</b>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('<b>');
    expect(html).toContain('bold');
  });
});
