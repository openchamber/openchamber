import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { DIFF_TOOLBAR_MENU_STEPS, fitToolbar } from './useDiffToolbarFit';

// The row's content width at each collapse step, as layout would report it.
const WIDTH = { full: 520, noWalkthroughLabel: 450, compact: 330 };

describe('fitToolbar', () => {
  let win: Window;
  let previousDocument: PropertyDescriptor | undefined;
  let toolbar: HTMLElement;
  let base: HTMLElement;
  let available: number;
  let baseClipped: (toolbar: HTMLElement) => boolean;

  beforeEach(() => {
    win = new Window();
    previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: win.document, configurable: true, writable: true });
    toolbar = document.createElement('div');
    base = document.createElement('span');
    base.className = 'truncate';
    toolbar.appendChild(base);
    baseClipped = () => false;
    Object.defineProperty(toolbar, 'clientWidth', { get: () => available });
    Object.defineProperty(toolbar, 'scrollWidth', { get: () => Math.max(available, contentWidth()) });
    Object.defineProperty(base, 'clientWidth', { get: () => 80 });
    Object.defineProperty(base, 'scrollWidth', { get: () => (baseClipped(toolbar) ? 120 : 80) });
  });

  afterEach(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    void win.happyDOM.close();
  });

  const steps = () => ['data-diff-toolbar-compact-walkthrough', 'data-diff-toolbar-compact'].filter((step) => toolbar.hasAttribute(step));
  const menuSteps = () => Object.values(DIFF_TOOLBAR_MENU_STEPS).filter((step) => toolbar.hasAttribute(step));
  // Past the compact labels each option moved into "More actions" frees 28px;
  // the first one also shows the menu button, so it frees nothing.
  function contentWidth(): number {
    if (!toolbar.hasAttribute('data-diff-toolbar-compact')) {
      return toolbar.hasAttribute('data-diff-toolbar-compact-walkthrough') ? WIDTH.noWalkthroughLabel : WIDTH.full;
    }
    const moved = menuSteps().length;
    return moved === 0 ? WIDTH.compact : WIDTH.compact - 28 * (moved - 1);
  }

  test('keeps every label while the row fits', () => {
    available = 600;
    fitToolbar(toolbar);
    expect(steps()).toEqual([]);
  });

  test('drops the walkthrough label first, then the rest, only as far as needed', () => {
    available = 480;
    fitToolbar(toolbar);
    expect(steps()).toEqual(['data-diff-toolbar-compact-walkthrough']);

    available = 400;
    fitToolbar(toolbar);
    expect(steps()).toEqual(['data-diff-toolbar-compact-walkthrough', 'data-diff-toolbar-compact']);

    available = 600;
    fitToolbar(toolbar);
    expect(steps()).toEqual([]);
  });

  test('takes a toolbar\'s own steps and ignores truncated text it was not told to watch', () => {
    const fit = { steps: ['data-step-one', 'data-step-two', 'data-step-three'] };
    const header = document.createElement('div');
    header.appendChild(base);
    const widthAt = () => (header.hasAttribute('data-step-two') ? 240 : header.hasAttribute('data-step-one') ? 400 : 560);
    Object.defineProperty(header, 'clientWidth', { get: () => available });
    Object.defineProperty(header, 'scrollWidth', { get: () => Math.max(available, widthAt()) });
    baseClipped = () => true;
    const taken = () => fit.steps.filter((step) => header.hasAttribute(step));

    available = 600;
    fitToolbar(header, fit);
    expect(taken()).toEqual([]);

    available = 300;
    fitToolbar(header, fit);
    expect(taken()).toEqual(['data-step-one', 'data-step-two']);
  });

  test('collapses labels before a branch name is clipped', () => {
    available = 600;
    baseClipped = (row) => !row.hasAttribute('data-diff-toolbar-compact-walkthrough');
    fitToolbar(toolbar);
    expect(steps()).toEqual(['data-diff-toolbar-compact-walkthrough']);
  });

  describe('view options in "More actions"', () => {
    test('stay in the row while it fits, even with a clipped picker name', () => {
      available = WIDTH.compact;
      baseClipped = () => true;
      fitToolbar(toolbar);
      expect(steps()).toEqual(['data-diff-toolbar-compact-walkthrough', 'data-diff-toolbar-compact']);
      expect(menuSteps()).toEqual([]);
    });

    test('move from the end of the row, only as many as it needs', () => {
      available = WIDTH.compact - 40;
      fitToolbar(toolbar);
      expect(menuSteps()).toEqual([
        DIFF_TOOLBAR_MENU_STEPS.layout,
        DIFF_TOOLBAR_MENU_STEPS.whitespace,
        DIFF_TOOLBAR_MENU_STEPS.wrap,
      ]);

      available = WIDTH.compact;
      fitToolbar(toolbar);
      expect(menuSteps()).toEqual([]);
    });
  });
});
