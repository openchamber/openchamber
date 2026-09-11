import { describe, expect, test } from 'bun:test';

import {
  annotationTargetCount,
  isBrowserAnnotationPayload,
  isBrowserElementTarget,
  navStatusUrl,
  type BrowserAnnotationPayload,
  type BrowserElementTarget,
} from './contract';

const element: BrowserElementTarget = {
  tag: 'button',
  text: 'Save',
  selector: '#save',
  path: 'main > form > button#save',
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  center: { x: 60, y: 40 },
  attributes: { id: 'save' },
  computedStyle: { display: 'flex' },
  ancestry: [{ tag: 'form', selectorPart: 'form' }],
};

const payload: BrowserAnnotationPayload = {
  id: 'annotation-1',
  pageUrl: 'http://localhost:5173/settings',
  pageTitle: 'Settings',
  viewport: { width: 1280, height: 800 },
  devicePixelRatio: 2,
  comment: 'Make this primary',
  elements: [{ id: 'element-1', element }],
  regions: [{ id: 'region-1', rect: { x: 200, y: 0, width: 50, height: 50 } }],
  strokes: [],
};

describe('navigation status', () => {
  test('idle carries no url; the other states carry the one they describe', () => {
    expect(navStatusUrl({ kind: 'idle' })).toBe('');
    expect(navStatusUrl({ kind: 'loading', url: 'http://a/' })).toBe('http://a/');
    expect(navStatusUrl({ kind: 'ready', url: 'http://a/', title: 'A' })).toBe('http://a/');
    expect(navStatusUrl({ kind: 'failed', url: 'http://a/', code: -6, description: 'FILE_NOT_FOUND' }))
      .toBe('http://a/');
  });
});

describe('element target validation', () => {
  test('accepts a fully-formed target', () => {
    expect(isBrowserElementTarget(element)).toBe(true);
  });

  test('rejects payloads that would only fail later, at prompt or draw time', () => {
    expect(isBrowserElementTarget({ ...element, attributes: { id: 3 } })).toBe(false);
    expect(isBrowserElementTarget({ ...element, computedStyle: { display: null } })).toBe(false);
    expect(isBrowserElementTarget({ ...element, ancestry: [{ tag: 'form' }] })).toBe(false);
    expect(isBrowserElementTarget({ ...element, center: { x: 1 } })).toBe(false);
    expect(isBrowserElementTarget({ ...element, bounds: { x: 1, y: 2, width: 3 } })).toBe(false);
  });

  test('rejects non-finite geometry rather than passing NaN downstream', () => {
    expect(isBrowserElementTarget({ ...element, bounds: { x: Number.NaN, y: 0, width: 1, height: 1 } })).toBe(false);
  });
});

describe('annotation payload validation', () => {
  test('accepts a complete payload', () => {
    expect(isBrowserAnnotationPayload(payload)).toBe(true);
  });

  test('accepts a payload with nothing marked but a comment', () => {
    expect(isBrowserAnnotationPayload({ ...payload, elements: [], regions: [], strokes: [] }))
      .toBe(true);
  });

  test('rejects a payload whose nested element is malformed', () => {
    expect(isBrowserAnnotationPayload({
      ...payload,
      elements: [{ id: 'element-1', element: { ...element, selector: 12 } }],
    })).toBe(false);
  });

  test('rejects a malformed stroke', () => {
    expect(isBrowserAnnotationPayload({
      ...payload,
      strokes: [{ id: 's', points: [{ x: 1 }], bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    })).toBe(false);
  });
});

describe('target geometry', () => {
  test('counts every kind of target', () => {
    expect(annotationTargetCount(payload)).toBe(2);
    expect(annotationTargetCount({ ...payload, elements: [], regions: [], strokes: [] })).toBe(0);
  });
});
