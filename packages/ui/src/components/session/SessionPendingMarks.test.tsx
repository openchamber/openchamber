import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { SessionPendingMarks } from './SessionPendingMarks';

const GLOBAL_NAMES = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];

describe('SessionPendingMarks', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const render = async (props: React.ComponentProps<typeof SessionPendingMarks>) => {
    await act(async () => root.render(<I18nProvider><SessionPendingMarks {...props} /></I18nProvider>));
  };

  const marks = () => Array.from(host.querySelectorAll<HTMLElement>('[data-session-pending-mark]'));

  beforeEach(() => {
    windowInstance = new Window();
    globalDescriptors = new Map(GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      await windowInstance.happyDOM.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('a row draw native titles: the shield, then the question mark', async () => {
    await render({ hasPermission: true, hasForm: true });
    expect(marks().map((mark) => mark.dataset.sessionPendingMark)).toEqual(['permission', 'form']);
    expect(marks().map((mark) => mark.getAttribute('aria-label'))).toEqual(['Permission required', 'Pending question']);
    expect(marks().map((mark) => mark.getAttribute('title'))).toEqual(['Permission required', 'Pending question']);
  });

  test('a clickable header keeps the labels but lets its own tooltip name the marks', async () => {
    await render({ hasPermission: true, hasForm: true, tooltip: true });
    expect(marks().map((mark) => mark.getAttribute('aria-label'))).toEqual(['Permission required', 'Pending question']);
    expect(marks().every((mark) => mark.getAttribute('title') === null)).toBe(true);
  });

  test('the question mark is the permission shield\'s peer, not a chip', async () => {
    await render({ hasPermission: true, hasForm: true });
    for (const mark of marks()) {
      expect(mark.className).toContain('shrink-0');
      expect(mark.className).not.toContain('border');
      expect(mark.className).not.toContain('bg-');
      expect(mark.className).not.toContain('rounded');
      const glyph = mark.querySelector('svg');
      expect(glyph?.getAttribute('class')).toContain('size-3');
    }
    expect(marks()[0].querySelector('use')?.getAttribute('href')).toBe('#oc-shield');
    expect(marks()[1].querySelector('use')?.getAttribute('href')).toBe('#oc-question');
  });

  test('draws only what waits, and nothing when nothing does', async () => {
    await render({ hasPermission: true, hasForm: false });
    expect(marks().map((mark) => mark.dataset.sessionPendingMark)).toEqual(['permission']);

    await render({ hasPermission: false, hasForm: true });
    expect(marks().map((mark) => mark.dataset.sessionPendingMark)).toEqual(['form']);

    await render({ hasPermission: false, hasForm: false });
    expect(marks()).toEqual([]);
  });
});
