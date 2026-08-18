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
