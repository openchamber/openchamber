import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';

import {
  ANNOTATION_TEARDOWN_SCRIPT,
  buildAnnotationOverlayScript,
  type BrowserAnnotationOverlayLabels,
  type BrowserAnnotationOverlayTheme,
} from './annotationOverlay';

const theme: BrowserAnnotationOverlayTheme = {
  colorScheme: 'dark',
  primary: 'rgb(214, 93, 42)',
  primarySoft: 'rgba(214, 93, 42, 0.16)',
  primaryFaint: 'rgba(214, 93, 42, 0.1)',
  primaryContrast: 'rgb(255, 255, 255)',
  surface: 'rgb(10, 10, 10)',
  surfaceElevated: 'rgb(20, 20, 20)',
  glassSurface: 'rgba(20, 20, 20, 0.64)',
  glassFilter: 'blur(26px) saturate(1.16)',
  border: 'rgb(40, 40, 40)',
  text: 'rgb(240, 240, 240)',
  mutedText: 'rgb(160, 160, 160)',
};

const labels: BrowserAnnotationOverlayLabels = {
  select: 'Element',
  marquee: 'Region',
  draw: 'Draw',
  commentPlaceholder: 'Describe the change...',
  submit: 'Attach',
};

/**
 * The overlay ships as source text evaluated inside another page, so ordinary
 * type-checking never sees it. These are the failures that produced: a stray
 * backtick silently truncated the whole script, and a value interpolated
 * without escaping would end it early or run as code.
 */
const parses = (source: string): boolean => {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
};

describe('annotation overlay script', () => {
  const script = buildAnnotationOverlayScript(theme, labels);

  test('parses as JavaScript', () => {
    expect(parses(`return ${script}`)).toBe(true);
  });

  test('contains no backtick, which would terminate the template it lives in', () => {
    expect(script).not.toContain('`');
  });

  test('carries the theme and labels through as data, not as concatenated code', () => {
    expect(script).toContain(JSON.stringify(theme.primarySoft));
    expect(script).toContain(JSON.stringify(labels.commentPlaceholder));
  });

  test('keeps comment keystrokes away from shortcuts on the annotated page', () => {
    expect(script).toContain("comment.addEventListener('keydown', onCommentKeyDown)");
    expect(script).toContain('var onCommentKeyDown = function (event) {');
    expect(script).toContain('event.stopPropagation();');
  });

  test('does not attach a comment while IME composition is active', () => {
    const handlerStart = script.indexOf('var onCommentKeyDown = function (event) {');
    const handlerEnd = script.indexOf('};', handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const handler = script.slice(handlerStart, handlerEnd);
    const imeGuard = handler.indexOf('event.isComposing || event.keyCode === 229');
    const attachCall = handler.indexOf('attach();');
    expect(imeGuard).toBeGreaterThan(-1);
    expect(attachCall).toBeGreaterThan(imeGuard);
  });

  test('preserves the overlay for composition Escape and cancels on ordinary Escape', async () => {
    const win = new Window({ url: 'http://annotation.test' });
    const run = new Function('window', 'document', 'requestAnimationFrame', `return ${script}`);
    try {
      const completion = run(win, win.document, (callback: FrameRequestCallback) => callback(0));
      const hostCount = win.document.body.children.length;
      expect(hostCount).toBeGreaterThan(0);
      for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
        const event = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options });
        win.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(win.document.body.children.length).toBe(hostCount);
      }
      const escape = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      win.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(await completion).toBeNull();
      expect(win.document.body.children.length).toBe(0);
    } finally {
      await win.happyDOM.close();
    }
  });

  test('guards app-side annotation Escape before cancelling the session', () => {
    const source = readFileSync(new URL('../../components/browser/BrowserPane.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const handler = (event: KeyboardEvent)');
    const end = source.indexOf("window.addEventListener('keydown', handler, true)", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    const guard = handler.indexOf("if (isIMECompositionEvent(event) || event.key !== 'Escape') return;");
    expect(guard).toBeGreaterThan(-1);
    expect(handler.indexOf('cancelAnnotationSession(annotationHost)')).toBeGreaterThan(guard);
  });

  test('escapes a label that would otherwise close the script', () => {
    const hostile = buildAnnotationOverlayScript(theme, {
      ...labels,
      submit: '"); alert(1); ("',
    });
    expect(parses(`return ${hostile}`)).toBe(true);
    expect(hostile).not.toContain('alert(1); ("');
  });

  test('the teardown script parses on its own', () => {
    expect(parses(ANNOTATION_TEARDOWN_SCRIPT)).toBe(true);
  });
});
