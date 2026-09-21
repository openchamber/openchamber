import { describe, expect, test } from 'bun:test';

import { formatBrowserAnnotationPrompt } from './annotationPrompt';
import type { BrowserAnnotationPayload, BrowserElementTarget } from './contract';

const element = (overrides: Partial<BrowserElementTarget> = {}): BrowserElementTarget => ({
  tag: 'button',
  text: '  Save   changes  ',
  selector: '#save',
  path: 'form > button#save',
  bounds: { x: 10.4, y: 20.6, width: 100, height: 40 },
  center: { x: 60, y: 40 },
  attributes: { id: 'save', 'aria-label': 'Save' },
  computedStyle: { display: 'flex', position: 'static', color: 'rgb(0, 0, 0)' },
  ancestry: [{ tag: 'form', selectorPart: 'form' }],
  ...overrides,
});

const basePayload = (overrides: Partial<BrowserAnnotationPayload> = {}): BrowserAnnotationPayload => ({
  id: 'annotation-1',
  pageUrl: 'http://localhost:5173/settings',
  pageTitle: 'Settings',
  viewport: { width: 1280, height: 800 },
  devicePixelRatio: 2,
  comment: '',
  elements: [],
  regions: [],
  strokes: [],
  ...overrides,
});

describe('annotation prompt', () => {
  test('describes each selected element with selector, ancestry and attributes', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload({ elements: [{ id: 'e1', element: element() }] }),
      screenshotAttached: true,
      intro: 'Selected elements:',
    });

    expect(output).toContain('Selected elements:');
    expect(output).toContain('Element 1: button');
    expect(output).toContain('- Selector: #save');
    expect(output).toContain('- Ancestry: form');
    expect(output).toContain('aria-label="Save"');
    expect(output).toContain('Screenshot: attached');
  });

  test('collapses element text whitespace', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload({ elements: [{ id: 'e1', element: element() }] }),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(output).toContain('- Text: Save   changes');
  });

  test('rounds geometry so the prompt has no float noise', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload({ elements: [{ id: 'e1', element: element() }] }),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(output).toContain('- Bounds: x=10, y=21, width=100, height=40');
  });

  test('reports a missing screenshot rather than staying silent about it', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload({ elements: [{ id: 'e1', element: element() }] }),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(output).toContain('Screenshot: not attached');
  });

  test('numbers multiple elements, regions and drawings independently', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload({
        elements: [{ id: 'e1', element: element() }, { id: 'e2', element: element({ selector: '#cancel' }) }],
        regions: [{ id: 'r1', rect: { x: 0, y: 0, width: 10, height: 10 } }],
        strokes: [{ id: 's1', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], bounds: { x: 0, y: 0, width: 5, height: 5 } }],
      }),
      screenshotAttached: true,
      intro: 'Selected',
    });

    expect(output).toContain('Element 1: button');
    expect(output).toContain('Element 2: button');
    expect(output).toContain('Region 1: x=0, y=0, width=10, height=10');
    expect(output).toContain('Drawing 1: 2 points');
  });

  test('includes the comment only when the user wrote one', () => {
    const withComment = formatBrowserAnnotationPrompt({
      payload: basePayload({ comment: '  needs more contrast  ', elements: [{ id: 'e1', element: element() }] }),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(withComment).toContain('Comment: needs more contrast');

    const withoutComment = formatBrowserAnnotationPrompt({
      payload: basePayload({ elements: [{ id: 'e1', element: element() }] }),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(withoutComment).not.toContain('Comment:');
  });

  test('falls back to the url when the page has no title', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload({ pageTitle: '' }),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(output).toContain('Page: http://localhost:5173/settings');
    expect(output).not.toContain('URL:');
  });

  test('keeps the url on its own line when a title is present', () => {
    const output = formatBrowserAnnotationPrompt({
      payload: basePayload(),
      screenshotAttached: false,
      intro: 'Selected',
    });
    expect(output).toContain('Page: Settings');
    expect(output).toContain('URL: http://localhost:5173/settings');
  });
});
