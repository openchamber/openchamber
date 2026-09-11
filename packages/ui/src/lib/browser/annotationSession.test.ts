import { describe, expect, test } from 'bun:test';

import { cancelAnnotationSession, runAnnotationSession, type AnnotationHost, type PageCapture } from './annotationSession';
import type { BrowserAnnotationOverlayLabels, BrowserAnnotationOverlayTheme } from './annotationOverlay';

const theme: BrowserAnnotationOverlayTheme = {
  colorScheme: 'dark',
  primary: 'rgb(1, 2, 3)',
  primarySoft: 'rgba(1, 2, 3, 0.16)',
  primaryFaint: 'rgba(1, 2, 3, 0.1)',
  primaryContrast: 'rgb(255, 255, 255)',
  surface: 'rgb(10, 10, 10)',
  surfaceElevated: 'rgb(20, 20, 20)',
  glassSurface: 'rgba(20, 20, 20, 0.64)',
  glassFilter: 'blur(26px) saturate(1.16)',
  border: 'rgb(30, 30, 30)',
  text: 'rgb(240, 240, 240)',
  mutedText: 'rgb(160, 160, 160)',
};

const labels = {
  select: 'Element', marquee: 'Region', draw: 'Draw',
  commentPlaceholder: 'Describe', submit: 'Attach',
} satisfies BrowserAnnotationOverlayLabels;

const validPayload = {
  id: 'annotation-1',
  pageUrl: 'http://localhost:5173/',
  pageTitle: 'App',
  viewport: { width: 1000, height: 700 },
  devicePixelRatio: 1,
  comment: 'tighten this',
  elements: [{
    id: 'element-1',
    element: {
      tag: 'div',
      text: 'Hi',
      selector: '#hero',
      path: 'main > div#hero',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      center: { x: 50, y: 25 },
      attributes: {},
      computedStyle: {},
      ancestry: [],
    },
  }],
  regions: [],
  strokes: [],
};

const capture: PageCapture = { mime: 'image/jpeg', base64: 'AAAA', width: 1000, height: 700 };

type Call = { code: string; gesture?: boolean };

const createHost = (options: {
  overlayResult: unknown;
  capturePage?: () => Promise<PageCapture | null>;
}): { host: AnnotationHost; calls: Call[] } => {
  const calls: Call[] = [];
  const host: AnnotationHost = {
    executeJavaScript: async (code: string, gesture?: boolean) => {
      calls.push({ code, gesture });
      if (code.includes('new Promise')) return options.overlayResult;
      if (code.includes('window.innerWidth')) return { width: 1000, height: 700 };
      return undefined;
    },
    capturePage: options.capturePage ?? (async () => capture),
  };
  return { host, calls };
};


describe('annotation session', () => {
  test('returns null when the user cancels inside the page', async () => {
    const { host } = createHost({ overlayResult: null });
    expect(await runAnnotationSession({ host, theme, labels })).toBeNull();
  });

  test('does not capture anything when the overlay was cancelled', async () => {
    let captures = 0;
    const { host } = createHost({
      overlayResult: null,
      capturePage: async () => { captures += 1; return null; },
    });
    await runAnnotationSession({ host, theme, labels });
    expect(captures).toBe(0);
  });

  test('discards a malformed payload and tears the overlay down', async () => {
    const { host, calls } = createHost({ overlayResult: { id: 'x', elements: 'not-an-array' } });
    const result = await runAnnotationSession({ host, theme, labels });
    expect(result).toBeNull();
    expect(calls.some((call) => call.code.includes('data-openchamber-annotation'))).toBe(true);
  });

  test('returns the annotation when the capture succeeds', async () => {
    const { host } = createHost({ overlayResult: validPayload });
    const result = await runAnnotationSession({ host, theme, labels });
    expect(result?.payload.id).toBe('annotation-1');
  });

  test('keeps the annotation when the capture throws', async () => {
    // A failed screenshot degrades the annotation; it must not discard it.
    const { host } = createHost({
      overlayResult: validPayload,
      capturePage: async () => { throw new Error('capture failed'); },
    });

    const result = await runAnnotationSession({ host, theme, labels });

    expect(result?.payload.id).toBe('annotation-1');
    expect(result?.screenshot).toBeNull();
  });

  test('keeps the annotation when capture returns nothing', async () => {
    const { host } = createHost({ overlayResult: validPayload, capturePage: async () => null });
    const result = await runAnnotationSession({ host, theme, labels });
    expect(result?.payload.comment).toBe('tighten this');
    expect(result?.screenshot).toBeNull();
  });

  test('runs the overlay with a user gesture so the page treats it as interactive', async () => {
    const { host, calls } = createHost({ overlayResult: null });
    await runAnnotationSession({ host, theme, labels });
    expect(calls[0]?.gesture).toBe(true);
  });

  test('cancelling a stale session tolerates a destroyed page', async () => {
    const host: AnnotationHost = {
      executeJavaScript: async () => { throw new Error('webview destroyed'); },
      capturePage: async () => null,
    };
    // Resolving at all is the contract: a destroyed page must not throw.
    expect(await cancelAnnotationSession(host)).toBeFalsy();
  });
});
