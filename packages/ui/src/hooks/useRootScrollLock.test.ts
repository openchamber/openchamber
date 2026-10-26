import { describe, expect, test } from 'bun:test';

import { isRootScrollTarget, resetRootScroll } from './useRootScrollLock';

type FakeElement = EventTarget & { id: string; scrollTop: number; scrollLeft: number };

const element = (id: string): FakeElement => Object.assign(new EventTarget(), { id, scrollTop: 0, scrollLeft: 0 });

/** Installs a minimal stand-in for `document` for the duration of `run`. */
const withDocument = (setup: { root?: FakeElement }, run: () => void) => {
  const fakeDocument = {
    documentElement: element('html'),
    body: element('body'),
    getElementById: (id: string) => (setup.root && setup.root.id === id ? setup.root : null),
  };
  // The hook only reads documentElement/body/getElementById from `document`;
  // this stand-in provides exactly those members for a DOM-less test process.
  const hadDocument = 'document' in globalThis;
  const previous = hadDocument ? globalThis.document : undefined;
  Reflect.set(globalThis, 'document', fakeDocument);
  try {
    run();
  } finally {
    if (hadDocument) Reflect.set(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
};

describe('resetRootScroll', () => {
  test('snaps every root scroll offset back to zero and reports the reset', () => {
    const root = element('root');
    withDocument({ root }, () => {
      document.documentElement.scrollTop = 48;
      document.body.scrollLeft = 12;
      root.scrollTop = 200;
      expect(resetRootScroll()).toBe(true);
      expect(document.documentElement.scrollTop).toBe(0);
      expect(document.body.scrollLeft).toBe(0);
      expect(root.scrollTop).toBe(0);
    });
  });

  test('reports nothing to do when the root is already at zero', () => {
    withDocument({}, () => {
      expect(resetRootScroll()).toBe(false);
    });
  });
});

describe('isRootScrollTarget', () => {
  test('recognises the document, html and body as root scroll sources', () => {
    withDocument({}, () => {
      expect(isRootScrollTarget(document)).toBe(true);
      expect(isRootScrollTarget(document.documentElement)).toBe(true);
      expect(isRootScrollTarget(document.body)).toBe(true);
    });
  });

  test('ignores scroll events from inner containers', () => {
    withDocument({}, () => {
      expect(isRootScrollTarget(element('chat-timeline'))).toBe(false);
    });
  });
});
