import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement,
  HTMLCanvasElement: browser.HTMLCanvasElement,
  HTMLAnchorElement: browser.HTMLAnchorElement,
  Element: browser.Element,
  Node: browser.Node,
  MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  devicePixelRatio: 1,
});
// happy-dom has no canvas implementation and Excalidraw reads a 2D context while
// loading; a stub with the properties it probes is enough, because nothing in
// this test draws.
Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({ filter: 'none', measureText: () => ({ width: 0 }), getImageData: () => ({ data: [] }) }),
});
afterAll(() => {
  browser.close();
});

const scene = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [
    {
      id: 'rect-1',
      type: 'rectangle',
      x: 120,
      y: 100,
      width: 220,
      height: 120,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: '#a5d8ff',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 123456,
      version: 5,
      versionNonce: 98765,
      isDeleted: false,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
    },
  ],
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
});

const { openExcalidrawDocument, parseExcalidrawDocument, serializeExcalidrawDocument } = await import('./document');

describe('excalidraw document round-trip', () => {
  test('parses a real scene into elements and appState', () => {
    const parsed = parseExcalidrawDocument(scene);
    expect(parsed).not.toBeNull();
    expect(parsed?.scene.elements).toHaveLength(1);
    expect(parsed?.scene.elements[0].id).toBe('rect-1');
    expect(parsed?.scene.appState.viewBackgroundColor).toBe('#ffffff');
  });

  test('serializes back to a valid, re-parseable Excalidraw document', () => {
    const parsed = parseExcalidrawDocument(scene);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    const written = serializeExcalidrawDocument(parsed.container, parsed.scene);
    const reparsed: { type?: string; elements?: unknown[] } = JSON.parse(written);
    expect(reparsed.type).toBe('excalidraw');
    expect(Array.isArray(reparsed.elements)).toBe(true);
    expect(reparsed.elements).toHaveLength(1);

    const again = parseExcalidrawDocument(written);
    expect(again?.scene.elements[0].id).toBe('rect-1');
  });

  test('refuses content that is not a scene instead of returning a blank one', () => {
    expect(parseExcalidrawDocument('{}')).toBeNull();
    expect(parseExcalidrawDocument('not json')).toBeNull();
    expect(parseExcalidrawDocument('{"elements":"nope"}')).toBeNull();
  });

  test('a parse is stable across a serialize/re-parse round trip', () => {
    const first = parseExcalidrawDocument(scene);
    expect(first).not.toBeNull();
    if (!first) return;

    const written = serializeExcalidrawDocument(first.container, first.scene);
    const second = parseExcalidrawDocument(written);
    expect(second).not.toBeNull();
    if (!second) return;

    expect(second.scene.elements.map((element) => [element.id, element.version, element.versionNonce]))
      .toEqual(first.scene.elements.map((element) => [element.id, element.version, element.versionNonce]));
  });

  test('rewrites an Obsidian drawing block and preserves the surrounding markdown', () => {
    const markdown = [
      '---',
      'excalidraw-plugin: parsed',
      'tags: [excalidraw]',
      '---',
      '',
      '# Excalidraw Data',
      '',
      '## Text Elements',
      'CRM ^EDfpboL1',
      '',
      '## Drawing',
      '```json',
      scene,
      '```',
      '%%',
      '',
    ].join('\n');

    const parsed = parseExcalidrawDocument(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed?.container.kind).toBe('drawing');
    expect(parsed?.scene.elements[0].id).toBe('rect-1');
    if (!parsed) return;

    const written = serializeExcalidrawDocument(parsed.container, parsed.scene);
    expect(written.startsWith('---\nexcalidraw-plugin: parsed')).toBe(true);
    expect(written.endsWith('```\n%%\n')).toBe(true);
    expect(written).toContain('CRM ^EDfpboL1');
    expect(parseExcalidrawDocument(written)?.scene.elements[0].id).toBe('rect-1');
  });

  test('round-trips an Obsidian compressed-json block', async () => {
    const { compressToBase64 } = await import('lz-string');
    const payload = compressToBase64(scene);
    const markdown = [
      '## Drawing',
      '```compressed-json',
      payload,
      '```',
      '%%',
      '',
    ].join('\n');

    const parsed = parseExcalidrawDocument(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed?.scene.elements[0].id).toBe('rect-1');
    if (!parsed) return;

    const written = serializeExcalidrawDocument(parsed.container, parsed.scene);
    expect(written).toContain('```compressed-json');
    expect(parseExcalidrawDocument(written)?.scene.elements[0].id).toBe('rect-1');
  });
});

describe('new excalidraw files', () => {
  test('an empty .excalidraw opens a blank scene instead of failing', () => {
    const doc = openExcalidrawDocument('', 'json');
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(doc.scene.elements).toHaveLength(0);
    expect(doc.container.kind).toBe('json');

    const written = serializeExcalidrawDocument(doc.container, doc.scene);
    const reparsed: { type?: string; elements?: unknown[] } = JSON.parse(written);
    expect(reparsed.type).toBe('excalidraw');
    expect(reparsed.elements).toHaveLength(0);
  });

  test('a whitespace-only file is blank too', () => {
    expect(openExcalidrawDocument('\n\n  \n', 'json')).not.toBeNull();
    expect(openExcalidrawDocument('   ', 'obsidian')).not.toBeNull();
  });

  test('an empty .excalidraw.md is written as a minimal Obsidian document', () => {
    const doc = openExcalidrawDocument('', 'obsidian');
    expect(doc).not.toBeNull();
    if (!doc) return;

    const written = serializeExcalidrawDocument(doc.container, doc.scene);
    expect(written.startsWith('---\nexcalidraw-plugin: parsed')).toBe(true);
    expect(written).toContain('## Drawing');
    expect(written).toContain('```compressed-json');
    expect(written.endsWith('```\n%%\n')).toBe(true);

    const reparsed = parseExcalidrawDocument(written);
    expect(reparsed?.container.kind).toBe('drawing');
    expect(reparsed?.scene.elements).toHaveLength(0);
  });

  test('refuses non-empty content it cannot parse', () => {
    expect(openExcalidrawDocument('garbage', 'json')).toBeNull();
    expect(openExcalidrawDocument('# just a note', 'obsidian')).toBeNull();
  });
});
