import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const withDom = async (run: () => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run();
  } finally {
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('a real Base UI modal retires a guest preview without relying on aria-modal or autofocus', () => withDom(async () => {
  const { createRoot } = await import('react-dom/client');
  const { Dialog } = await import('@base-ui/react/dialog');
  const { GuestPopover } = await import('./GuestPopover');
  const { guestPopoverOwnerBlocked } = await import('@/lib/guests/popovers');
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const closed: string[] = [];
  function View({ modal }: { modal: boolean }) {
    const [visible, setVisible] = React.useState(true);
    return <>
      {visible && <GuestPopover
        position={{ left: 20, top: 20, width: 240, height: 120, side: 'left' }}
        focused={false} label="Extension preview" ownerFrame={frame}
        onClose={(reason) => { closed.push(reason); setVisible(false); }}
        onEnter={() => {}} onLeave={() => {}} onOutsideHover={() => {}}
      ><div id="test-guest-preview-content">Guest content</div></GuestPopover>}
      {modal && <Dialog.Root defaultOpen>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup id="test-host-modal" initialFocus={false} aria-label="Host dialog">
            <Dialog.Title>Host dialog</Dialog.Title>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>}
    </>;
  }
  try {
    await act(async () => { root.render(<View modal={false} />); });
    expect(document.querySelector('[data-guest-popover-overlay]')).not.toBeNull();
    expect(guestPopoverOwnerBlocked(frame)).toBe(false);
    await act(async () => { root.render(<View modal />); });
    expect(document.getElementById('test-host-modal')).not.toBeNull();
    expect(document.getElementById('test-host-modal')?.getAttribute('aria-modal')).not.toBe('true');
    expect(frame.closest('[inert],[aria-hidden="true"],[data-base-ui-inert]')).not.toBeNull();
    expect(guestPopoverOwnerBlocked(frame)).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(closed).toContain('outside');
    expect(document.querySelector('[data-guest-popover-overlay]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    container.remove();
  }
}));

test('typing in host UI retires a preview the user is not using', () => withDom(async () => {
  const { createRoot } = await import('react-dom/client');
  const { GuestPopover } = await import('./GuestPopover');
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const composer = document.createElement('textarea');
  document.body.append(composer);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const closed: string[] = [];
  try {
    await act(async () => {
      root.render(<GuestPopover
        position={{ left: 20, top: 20, width: 240, height: 120, side: 'left' }}
        focused={false} label="Extension preview" ownerFrame={frame}
        onClose={(reason) => { closed.push(reason); }}
        onEnter={() => {}} onLeave={() => {}} onOutsideHover={() => {}}
      ><div>Guest content</div></GuestPopover>);
    });
    composer.focus();
    closed.length = 0;
    await act(async () => { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); });
    expect(closed).toEqual(['outside']);
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    composer.remove();
    container.remove();
  }
}));
