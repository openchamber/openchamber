import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { GuestPopoverController, guestPopoverOwnerBlocked, positionGuestPopover, watchGuestPopoverOwner } from './popovers.ts';

describe('positionGuestPopover', () => {
  test('translates an anchor through a scaled iframe and keeps the panel inside the viewport', () => {
    const positioned = positionGuestPopover({
      anchor: { x: 20, y: 40, width: 100, height: 30 },
      frame: { left: 100, top: 50, width: 400, height: 200, clientWidth: 200, clientHeight: 100 },
      viewport: { width: 500, height: 300 },
      width: 240,
      height: 120,
      side: 'left',
    });

    expect(positioned).toEqual({ left: 8, top: 100, width: 240, height: 120, side: 'left' });
  });

  test('flips a left popover when the viewport gutter leaves no room', () => {
    const positioned = positionGuestPopover({
      anchor: { x: 10, y: 10, width: 20, height: 20 },
      frame: { left: 10, top: 10, width: 100, height: 100, clientWidth: 100, clientHeight: 100 },
      viewport: { width: 400, height: 200 },
      width: 160,
      height: 80,
      side: 'left',
    });

    expect(positioned).toEqual({ left: 46, top: 8, width: 160, height: 80, side: 'right' });
  });

  test('rejects an anchor wholly outside the visible owner frame', () => {
    expect(positionGuestPopover({
      anchor: { x: 120, y: 10, width: 20, height: 20 },
      frame: { left: 10, top: 10, width: 100, height: 100, clientWidth: 100, clientHeight: 100 },
      viewport: { width: 400, height: 200 },
      width: 160,
      height: 80,
      side: 'left',
    })).toBeNull();
  });
});

describe('GuestPopoverController', () => {
  test('replaces the previous owner and ignores a delayed retirement from it', () => {
    const controller = new GuestPopoverController();
    const closed: string[] = [];
    const first = controller.claim({ id: 'first', authorize: () => true, close: (reason) => closed.push(`first:${reason}`) });
    const second = controller.claim({ id: 'second', authorize: () => true, close: (reason) => closed.push(`second:${reason}`) });
    controller.release(first);

    expect(closed).toEqual(['first:replaced']);
    expect(controller.current()).toBe(second);
  });

  test('retires an activation whose captured owner authority is gone', () => {
    let active = true;
    const controller = new GuestPopoverController();
    const closed: string[] = [];
    const activation = controller.claim({ id: 'preview', authorize: () => active, close: (reason) => closed.push(reason) });
    active = false;

    expect(controller.authorize(activation)).toBe(false);
    expect(closed).toEqual(['owner']);
    expect(controller.current()).toBeNull();
  });
});

describe('guestPopoverOwnerBlocked', () => {
  // The DOM under test is happy-dom's, installed as the global document so
  // the code sees the same types it sees in the app.
  const withDocument = async (run: (doc: Document) => Promise<void> | void) => {
    const dom = new Window({ url: 'http://localhost', settings: { disableIframePageLoading: true } });
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.document });
    try {
      await run(document);
    } finally {
      if (original) Object.defineProperty(globalThis, 'document', original);
      else Reflect.deleteProperty(globalThis, 'document');
      await dom.happyDOM.close();
    }
  };
  const shownModal = (doc: Document) => {
    const element = doc.createElement('div');
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    // happy-dom lays nothing out; a shown modal has a box.
    Object.defineProperty(element, 'getClientRects', { value: () => ({ length: 1 }) });
    doc.body.append(element);
    return element;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('a hidden modal, a modal the owner sits in and the sheet holding its popover leave it open; any other modal blocks it', () => withDocument((doc) => {
    // A closed drawer: still laid out off screen, hidden from everyone.
    shownModal(doc).setAttribute('aria-hidden', 'true');
    const drawer = shownModal(doc);
    const frame = doc.createElement('iframe');
    drawer.append(frame);
    expect(guestPopoverOwnerBlocked(frame)).toBe(false);

    const sheet = shownModal(doc);
    const overlay = doc.createElement('div');
    overlay.setAttribute('data-guest-popover-overlay', '');
    sheet.append(overlay);
    expect(guestPopoverOwnerBlocked(frame)).toBe(false);

    shownModal(doc);
    expect(guestPopoverOwnerBlocked(frame)).toBe(true);
  }));

  test('a watched popover closes when a host modal opens after it, and stays open for its own sheet', () => withDocument(async (doc) => {
    const frame = doc.createElement('iframe');
    doc.body.append(frame);
    let blocked = 0;
    const stop = watchGuestPopoverOwner(frame, () => { blocked += 1; });

    const sheet = shownModal(doc);
    const overlay = doc.createElement('div');
    overlay.setAttribute('data-guest-popover-overlay', '');
    sheet.append(overlay);
    await tick();
    expect(blocked).toBe(0);

    shownModal(doc);
    await tick();
    expect(blocked).toBe(1);
    stop();
  }));
});
