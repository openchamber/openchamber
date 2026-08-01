import { describe, expect, test } from 'bun:test';

import {
  handleFilesViewFind,
  reduceFilesViewFindState,
  renderFilesViewSurface,
} from './filesViewFind';

describe('FilesView find behavior (issue #1683)', () => {
  test('does not intercept find from a mounted hidden FilesView', () => {
    let prevented = false;
    let opened = false;
    const event = { preventDefault: () => { prevented = true; } };

    expect(handleFilesViewFind(false, true, event, () => { opened = true; })).toBe(false);
    expect(prevented).toBe(false);
    expect(opened).toBe(false);

    expect(handleFilesViewFind(true, true, event, () => { opened = true; })).toBe(true);
    expect(prevented).toBe(true);
    expect(opened).toBe(true);
  });

  test('keeps search open while moving between inline and fullscreen editors', () => {
    const openInline = { fullscreen: false, searchOpen: true };
    const fullscreen = reduceFilesViewFindState(openInline, { type: 'toggle-fullscreen' });
    const inlineAgain = reduceFilesViewFindState(fullscreen, { type: 'exit-fullscreen' });

    expect(fullscreen).toEqual({ fullscreen: true, searchOpen: true });
    expect(inlineAgain).toEqual(openInline);
  });

  test('mounts only the selected editor surface', () => {
    const mounted: string[] = [];
    const renderInline = () => { mounted.push('inline'); return 'inline'; };
    const renderFullscreen = () => { mounted.push('fullscreen'); return 'fullscreen'; };

    expect(renderFilesViewSurface(
      { fullscreen: false, searchOpen: true },
      renderInline,
      renderFullscreen,
    )).toBe('inline');
    expect(mounted).toEqual(['inline']);

    mounted.length = 0;
    expect(renderFilesViewSurface(
      { fullscreen: true, searchOpen: true },
      renderInline,
      renderFullscreen,
    )).toBe('fullscreen');
    expect(mounted).toEqual(['fullscreen']);
  });

  test('applies search panel close notifications', () => {
    const state = reduceFilesViewFindState(
      { fullscreen: true, searchOpen: true },
      { type: 'set-search-open', open: false },
    );

    expect(state).toEqual({ fullscreen: true, searchOpen: false });
  });
});
