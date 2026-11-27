import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { DIFF_TOOLBAR_MENU_STEPS, fitToolbar } from './useDiffToolbarFit';
import { WALKTHROUGH_HEADER_FIT } from './walkthrough/walkthroughHeaderFit';

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
  // Past the compact labels, the walkthrough moved into "More actions" frees
  // its 28px icon button.
  function contentWidth(): number {
    if (!toolbar.hasAttribute('data-diff-toolbar-compact')) {
      return toolbar.hasAttribute('data-diff-toolbar-compact-walkthrough') ? WIDTH.noWalkthroughLabel : WIDTH.full;
    }
    return WIDTH.compact - 28 * menuSteps().length;
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

  describe('the walkthrough in "More actions"', () => {
    test('stays in the row while it fits, even with a clipped picker name', () => {
      available = WIDTH.compact;
      baseClipped = () => true;
      fitToolbar(toolbar);
      expect(steps()).toEqual(['data-diff-toolbar-compact-walkthrough', 'data-diff-toolbar-compact']);
      expect(menuSteps()).toEqual([]);
    });

    test('moves into the menu only while the compact row still overflows', () => {
      available = WIDTH.compact - 20;
      fitToolbar(toolbar);
      expect(menuSteps()).toEqual([DIFF_TOOLBAR_MENU_STEPS.walkthrough]);

      available = WIDTH.compact;
      fitToolbar(toolbar);
      expect(menuSteps()).toEqual([]);
    });
  });

  describe('the walkthrough header', () => {
    let header: HTMLElement;
    let button: HTMLButtonElement;
    let label: HTMLElement;

    beforeEach(() => {
      header = document.createElement('div');
      const picker = document.createElement('div');
      picker.setAttribute('data-walkthrough-header-picker', '');
      button = document.createElement('button');
      label = document.createElement('span');
      label.className = 'truncate';
      button.appendChild(label);
      picker.appendChild(button);
      header.appendChild(picker);
      Object.defineProperty(header, 'clientWidth', { get: () => 600 });
      Object.defineProperty(header, 'scrollWidth', { get: () => 600 });
      Object.defineProperty(label, 'clientWidth', { get: () => 40 });
    });

    const headerSteps = () => ['data-walkthrough-header-compact', 'data-walkthrough-header-tight', 'data-walkthrough-header-minimal', 'data-walkthrough-header-narrow']
      .filter((step) => header.hasAttribute(step));

    test('keeps taking steps while a picker name stays clipped, even though the row fits', () => {
      Object.defineProperty(label, 'scrollWidth', { get: () => 120 });
      fitToolbar(header, WALKTHROUGH_HEADER_FIT);
      expect(headerSteps()).toEqual([
        'data-walkthrough-header-compact',
        'data-walkthrough-header-tight',
        'data-walkthrough-header-minimal',
        'data-walkthrough-header-narrow',
      ]);
    });

    test('stops at the first step where the picker name fits again', () => {
      Object.defineProperty(label, 'scrollWidth', {
        get: () => (header.hasAttribute('data-walkthrough-header-compact') ? 40 : 120),
      });
      fitToolbar(header, WALKTHROUGH_HEADER_FIT);
      expect(headerSteps()).toEqual(['data-walkthrough-header-compact']);
    });

    test('ignores a picker name clipped at its own width ceiling', () => {
      Object.defineProperty(label, 'scrollWidth', { get: () => 120 });
      Object.defineProperty(button, 'getBoundingClientRect', { value: () => ({ width: 192 }) });
      fitToolbar(header, WALKTHROUGH_HEADER_FIT);
      expect(headerSteps()).toEqual([]);
    });
  });
});
