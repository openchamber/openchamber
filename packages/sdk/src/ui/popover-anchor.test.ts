import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';

import type { HostClient } from '../host.ts';
import { mountPopoverAnchor } from './popover-anchor.ts';

type ClosedListener = Parameters<HostClient['onPopoverClosed']>[0];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const fixture = (keyboardFocus = true) => {
  const window = new Window();
  const originalObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = window.MutationObserver;
  cleanups.push(async () => { globalThis.MutationObserver = originalObserver; await window.happyDOM.close(); });
  const element = window.document.createElement('button');
  const matches = element.matches.bind(element);
  // Happy DOM has no input-modality tracking for :focus-visible.
  element.matches = (selector) => selector === ':focus-visible' ? keyboardFocus : matches(selector);
  element.getBoundingClientRect = () => new window.DOMRect(1, 1, 20, 20);
  window.document.body.append(element);
  const opens: Array<{ id: string; focus?: boolean }> = [];
  const activity: boolean[] = [];
  const closes: Array<{ id: string; reason?: string }> = [];
  let listener: ClosedListener | undefined;
  const host = {
    openPopover: async (request: { id: string; focus?: boolean }) => { opens.push(request); },
    closePopover: async (id: string, reason?: 'closed' | 'escape') => { closes.push({ id, reason }); },
    setPopoverAnchorActive: async (_id: string, active: boolean) => { activity.push(active); },
    onPopoverClosed: (next: ClosedListener) => { listener = next; return () => { listener = undefined; }; },
  } satisfies Pick<HostClient, 'openPopover' | 'closePopover' | 'setPopoverAnchorActive' | 'onPopoverClosed'>;
  return { window, element, host, opens, activity, closes, close: (id: string, reason: 'escape' | 'closed') => listener?.({ id, reason }) };
};

describe('mountPopoverAnchor', () => {
  test('opens after mouse hover and keeps the host anchor active while focus remains', async () => {
    const f = fixture();
    const handle = mountPopoverAnchor(f.element, { host: f.host, getData: () => ({ sha: 'abc' }), width: 160, height: 48 });
    f.element.dispatchEvent(new f.window.PointerEvent('pointerenter', { pointerType: 'mouse' }));
    await Bun.sleep(260);
    f.element.dispatchEvent(new f.window.FocusEvent('focus'));
    f.element.dispatchEvent(new f.window.PointerEvent('pointerleave', { pointerType: 'mouse' }));
    expect(f.opens).toHaveLength(1);
    expect(f.activity).toEqual([true, true]);
    handle.dispose();
  });

  test('closes for scroll, removal, and disposal without accepting a stale close event', async () => {
    const f = fixture();
    const handle = mountPopoverAnchor(f.element, { host: f.host, getData: () => null, width: 160, height: 48 });
    f.element.dispatchEvent(new f.window.FocusEvent('focus'));
    await Promise.resolve();
    const id = f.opens[0]?.id;
    if (!id) throw new Error('Expected popover open');
    f.window.document.dispatchEvent(new f.window.Event('scroll'));
    f.close('different', 'closed');
    expect(f.closes).toEqual([{ id, reason: 'closed' }]);
    handle.dispose();
    expect(f.closes).toHaveLength(1);
  });

  test('restores focus for Escape without reopening and preserves caller aria-expanded', async () => {
    const f = fixture();
    f.element.setAttribute('aria-expanded', 'false');
    const handle = mountPopoverAnchor(f.element, { host: f.host, getData: () => null, width: 160, height: 48 });
    f.element.dispatchEvent(new f.window.FocusEvent('focus'));
    await Promise.resolve();
    const id = f.opens[0]?.id;
    if (!id) throw new Error('Expected popover open');
    f.close(id, 'escape');
    await Promise.resolve();
    expect(f.opens).toHaveLength(1);
    expect(f.element.getAttribute('aria-expanded')).toBe('false');
    handle.dispose();
  });

  test('pointer focus does not create a transient preview and touch hover stays inactive', async () => {
    const f = fixture(false);
    const handle = mountPopoverAnchor(f.element, { host: f.host, getData: () => null, width: 160, height: 48 });
    f.element.dispatchEvent(new f.window.FocusEvent('focus'));
    f.element.dispatchEvent(new f.window.PointerEvent('pointerenter', { pointerType: 'touch' }));
    await Bun.sleep(260);
    expect(f.opens).toHaveLength(0);
    handle.dispose();
  });

  test('anchor removal closes a live opening and unbinding restores the caller labels', async () => {
    const f = fixture();
    f.element.setAttribute('aria-label', 'Commit row');
    const handle = mountPopoverAnchor(f.element, { host: f.host, getData: () => null, width: 160, height: 48, label: 'Preview' });
    f.element.focus();
    expect(f.opens).toHaveLength(1);
    f.element.remove();
    await f.window.happyDOM.waitUntilComplete();
    expect(f.closes).toHaveLength(1);
    handle.dispose();
    expect(f.element.getAttribute('aria-label')).toBe('Commit row');
    expect(f.element.getAttribute('aria-haspopup')).toBeNull();
  });

  test('a new pointer move can reopen after crossing iframe documents without an enter event', async () => {
    const f = fixture();
    const handle = mountPopoverAnchor(f.element, { host: f.host, getData: () => null, width: 160, height: 48 });
    f.element.focus();
    const first = f.opens[0];
    if (!first) throw new Error('Preview missing');
    f.close(first.id, 'escape');
    await Promise.resolve();
    f.element.dispatchEvent(new f.window.PointerEvent('pointermove', { pointerType: 'mouse' }));
    await Bun.sleep(260);
    expect(f.opens).toHaveLength(2);
    expect(f.opens[1]?.id).not.toBe(first.id);
    handle.dispose();
  });
});
