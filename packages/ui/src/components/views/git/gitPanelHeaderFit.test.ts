import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { fitToolbar } from '../useDiffToolbarFit';
import { GIT_PANEL_HEADER_FIT } from './gitPanelHeaderFit';

// How wide the pickers need to be at each step, as layout would report it: the
// repository picker is already down to its icon at step zero, the branch picker
// gives way next, then hiding the sync word and its counts frees row room.
const PICKERS = { full: 220, branchShrinks: 124 };
const ROW = { full: 330, compact: 280, tight: 260 };

describe('Git panel header fit', () => {
  let win: Window;
  let previousDocument: PropertyDescriptor | undefined;
  let row: HTMLElement;
  let available: number;

  beforeEach(() => {
    win = new Window();
    previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: win.document, configurable: true, writable: true });
    row = document.createElement('div');
    const pickers = document.createElement('div');
    pickers.setAttribute('data-git-header-pickers', '');
    row.appendChild(pickers);
    const has = (step: string) => row.hasAttribute(step);
    // The pickers' slot gets what the rest of the row leaves.
    const slotWidth = () => available - (has('data-git-header-tight') ? ROW.tight : has('data-git-header-compact') ? ROW.compact : ROW.full) + PICKERS.branchShrinks;
    Object.defineProperty(row, 'clientWidth', { get: () => available });
    Object.defineProperty(row, 'scrollWidth', { get: () => available });
    Object.defineProperty(pickers, 'clientWidth', { get: () => slotWidth() });
    Object.defineProperty(pickers, 'scrollWidth', {
      get: () => Math.max(slotWidth(), has('data-git-header-branch-shrinks') ? PICKERS.branchShrinks : PICKERS.full),
    });
  });

  afterEach(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    void win.happyDOM.close();
  });

  const taken = () => GIT_PANEL_HEADER_FIT.steps.filter((step) => row.hasAttribute(step));

  test('keeps the sync word while the pickers can still give way', () => {
    available = 430;
    fitToolbar(row, GIT_PANEL_HEADER_FIT);
    expect(taken()).toEqual([]);

    available = 340;
    fitToolbar(row, GIT_PANEL_HEADER_FIT);
    expect(taken()).toEqual(['data-git-header-branch-shrinks']);
  });

  test('drops the word, then the counts, only while the pickers still overflow', () => {
    available = 300;
    fitToolbar(row, GIT_PANEL_HEADER_FIT);
    expect(taken()).toEqual(['data-git-header-branch-shrinks', 'data-git-header-compact']);

    available = 270;
    fitToolbar(row, GIT_PANEL_HEADER_FIT);
    expect(taken()).toEqual(['data-git-header-branch-shrinks', 'data-git-header-compact', 'data-git-header-tight']);

    available = 430;
    fitToolbar(row, GIT_PANEL_HEADER_FIT);
    expect(taken()).toEqual([]);
  });
});
