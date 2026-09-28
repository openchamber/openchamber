import { describe, expect, test } from 'bun:test';

import {
  excalidrawDrawingBlock,
  excalidrawFormatForPath,
  excalidrawSceneSignature,
  isExcalidrawDocument,
  isExcalidrawMountable,
  shouldShowExcalidrawCanvas,
  createExcalidrawSaveTracker,
} from './scene';

const obsidian = (lang: string, payload: string) =>
  ['---', 'excalidraw-plugin: parsed', '---', '', '# Excalidraw Data', '', '## Drawing', `\`\`\`${lang}`, payload, '```', '%%'].join('\n');

describe('excalidrawDrawingBlock', () => {
  test('extracts an Obsidian drawing payload without its markdown wrapper', () => {
    const content = obsidian('json', '{"type":"excalidraw","elements":[]}');
    const block = excalidrawDrawingBlock(content);
    expect(block).not.toBeNull();
    if (!block) return;
    expect(block.compressed).toBe(false);
    expect(content.slice(block.start, block.end)).toBe('{"type":"excalidraw","elements":[]}');
  });

  test('marks a compressed-json block as compressed', () => {
    const content = obsidian('compressed-json', 'N4IgFg');
    const block = excalidrawDrawingBlock(content);
    expect(block).not.toBeNull();
    if (!block) return;
    expect(block.compressed).toBe(true);
    expect(content.slice(block.start, block.end)).toBe('N4IgFg');
  });

  test('finds nothing in a plain file', () => {
    expect(excalidrawDrawingBlock('plain text')).toBeNull();
    expect(excalidrawDrawingBlock('{"type":"excalidraw","elements":[]}')).toBeNull();
  });
});

describe('isExcalidrawDocument', () => {
  test('accepts a plain scene or an Obsidian drawing block', () => {
    expect(isExcalidrawDocument('{"type":"excalidraw","elements":[]}')).toBe(true);
    expect(isExcalidrawDocument('{ "elements": [{ "id": "a" }] }')).toBe(true);
    expect(isExcalidrawDocument(obsidian('json', '{}'))).toBe(true);
    expect(isExcalidrawDocument(obsidian('compressed-json', 'N4IgFg'))).toBe(true);
  });

  test('refuses anything that is not a scene', () => {
    expect(isExcalidrawDocument('')).toBe(false);
    expect(isExcalidrawDocument('# Notes')).toBe(false);
    expect(isExcalidrawDocument('not json')).toBe(false);
    expect(isExcalidrawDocument('{}')).toBe(false);
    expect(isExcalidrawDocument('{"elements":"nope"}')).toBe(false);
    expect(isExcalidrawDocument('[1,2,3]')).toBe(false);
    expect(isExcalidrawDocument('{"elements":[]')).toBe(false);
  });
});

describe('excalidrawSceneSignature', () => {
  const element = { version: 3, versionNonce: 11 };

  test('is stable for identical scenes', () => {
    const first = excalidrawSceneSignature([element], { viewBackgroundColor: '#fff' });
    const second = excalidrawSceneSignature([{ ...element }], { viewBackgroundColor: '#fff' });
    expect(first).toBe(second);
  });

  test('changes when an element edit bumps its version', () => {
    const before = excalidrawSceneSignature([element], {});
    const after = excalidrawSceneSignature([{ ...element, version: 4 }], {});
    expect(after).not.toBe(before);
  });

  test('ignores view-only appState such as scroll and zoom', () => {
    const idle = excalidrawSceneSignature([element], { viewBackgroundColor: '#fff' });
    const panned = excalidrawSceneSignature(
      [element],
      { viewBackgroundColor: '#fff', scrollX: 900, scrollY: 400 },
    );
    expect(panned).toBe(idle);
  });

  test('changes when a persisted appState field changes', () => {
    const before = excalidrawSceneSignature([element], { viewBackgroundColor: '#fff' });
    const after = excalidrawSceneSignature([element], { viewBackgroundColor: '#000' });
    expect(after).not.toBe(before);
  });
});

describe('excalidrawFormatForPath', () => {
  test('maps the Obsidian extension to the markdown container', () => {
    expect(excalidrawFormatForPath('/repo/board.excalidraw')).toBe('json');
    expect(excalidrawFormatForPath('/repo/board.excalidraw.md')).toBe('obsidian');
    expect(excalidrawFormatForPath('/repo/Board.Excalidraw.MD')).toBe('obsidian');
  });
});

describe('isExcalidrawMountable', () => {
  test('accepts blank content as a new drawing', () => {
    expect(isExcalidrawMountable('')).toBe(true);
    expect(isExcalidrawMountable('  \n ')).toBe(true);
  });

  test('accepts a scene or a drawing block and refuses the rest', () => {
    expect(isExcalidrawMountable('{"elements":[]}')).toBe(true);
    expect(isExcalidrawMountable(obsidian('json', '{}'))).toBe(true);
    expect(isExcalidrawMountable('garbage')).toBe(false);
    expect(isExcalidrawMountable('# just a note')).toBe(false);
  });
});

describe('shouldShowExcalidrawCanvas', () => {
  const shown = (overrides: Partial<Parameters<typeof shouldShowExcalidrawCanvas>[0]>) =>
    shouldShowExcalidrawCanvas({ isExcalidraw: true, viewMode: 'preview', previewReady: true, draft: '{"elements":[]}', ...overrides });

  test('mounts the canvas for a readable drawing in preview', () => {
    expect(shown({})).toBe(true);
    expect(shown({ draft: obsidian('json', '{"elements":[]}') })).toBe(true);
  });

  test('a new empty file opens as a blank canvas', () => {
    expect(shown({ draft: '' })).toBe(true);
  });

  test('never mounts over a draft the canvas cannot read, so a blank scene cannot be saved over it', () => {
    expect(shown({ draft: 'not a drawing' })).toBe(false);
    expect(shown({ draft: '# a note that lost its drawing block' })).toBe(false);
  });

  test('stays off in source mode, before the file finished loading, and for other files', () => {
    expect(shown({ viewMode: 'edit' })).toBe(false);
    expect(shown({ previewReady: false })).toBe(false);
    expect(shown({ isExcalidraw: false })).toBe(false);
  });
});

describe('createExcalidrawSaveTracker', () => {
  test('a stroke drawn while the save was writing stays unsaved', () => {
    const tracker = createExcalidrawSaveTracker('opened');
    expect(tracker.observe('stroke-1')).toEqual({ edited: true, dirty: true });
    // The save snapshots stroke-1, then another stroke lands before the write returns.
    tracker.observe('stroke-2');
    expect(tracker.markSaved('stroke-1')).toBe(true);
    expect(tracker.observe('stroke-2')).toEqual({ edited: false, dirty: true });
  });

  test('a save with nothing drawn during the write leaves the canvas clean', () => {
    const tracker = createExcalidrawSaveTracker('opened');
    tracker.observe('stroke-1');
    expect(tracker.markSaved('stroke-1')).toBe(false);
  });

  test('scrolling or selecting reports no edit', () => {
    const tracker = createExcalidrawSaveTracker('opened');
    expect(tracker.observe('opened')).toEqual({ edited: false, dirty: false });
  });
});

