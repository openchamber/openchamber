import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { fitToolbar } from '../useDiffToolbarFit';
import { GIT_PANEL_HEADER_FIT } from './gitPanelHeaderFit';

const WIDTH_AFTER = {
  none: 420,
  'data-git-header-review-icons': 330,
  'data-git-header-compact': 300,
  'data-git-header-tight': 285,
  'data-git-header-review-menu': 230,
  'data-git-header-scope-short': 210,
} as const;

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
    Object.defineProperty(row, 'clientWidth', { get: () => available });
    Object.defineProperty(row, 'scrollWidth', {
      get: () => {
        const taken = GIT_PANEL_HEADER_FIT.steps.filter((step) => row.hasAttribute(step));
        const last = taken.at(-1);
        return Math.max(available, last ? WIDTH_AFTER[last] : WIDTH_AFTER.none);
      },
    });
  });

  afterEach(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    void win.happyDOM.close();
  });

  const taken = () => GIT_PANEL_HEADER_FIT.steps.filter((step) => row.hasAttribute(step));
  const fitAt = (width: number) => {
    available = width;
    fitToolbar(row, GIT_PANEL_HEADER_FIT);
    return taken();
  };

  test('keeps the review actions with their words while the row fits', () => {
    expect(fitAt(430)).toEqual([]);
  });

  test('turns the review actions into icons before touching sync', () => {
    expect(fitAt(340)).toEqual(['data-git-header-review-icons']);
  });

  test('moves the review actions into the menu only after sync has given up its word and counts', () => {
    expect(fitAt(290)).toEqual(['data-git-header-review-icons', 'data-git-header-compact', 'data-git-header-tight']);
    expect(fitAt(240)).toEqual([
      'data-git-header-review-icons', 'data-git-header-compact', 'data-git-header-tight', 'data-git-header-review-menu',
    ]);
    expect(fitAt(215)).toEqual(GIT_PANEL_HEADER_FIT.steps.slice());
    expect(fitAt(430)).toEqual([]);
  });
});
