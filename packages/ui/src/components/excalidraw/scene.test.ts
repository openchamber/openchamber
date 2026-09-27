import { describe, expect, test } from 'bun:test';

import {
  excalidrawDrawingBlock,
  excalidrawFormatForPath,
  excalidrawSceneSignature,
  isExcalidrawDocument,
  isExcalidrawMountable,
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

