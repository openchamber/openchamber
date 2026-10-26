import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useScrollDismissedTooltip } from './useScrollDismissedTooltip';

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

const Row = ({ label }: { label: string }) => {
  const tooltip = useScrollDismissedTooltip();
  return (
    <Tooltip actionsRef={tooltip.actionsRef} onOpenChange={tooltip.onOpenChange}>
      <TooltipTrigger asChild><button type="button" data-row={label}>{label}</button></TooltipTrigger>
      <TooltipContent>{`${label} details`}</TooltipContent>
    </Tooltip>
  );
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('session row tooltips while the list scrolls', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;

  beforeEach(async () => {
    dom = installDom();
    root = createRoot(dom.container);
    await act(async () => root.render(
      <TooltipProvider delay={0} closeDelay={0}>
        <div data-list="">
          <Row label="first" />
          <Row label="second" />
        </div>
        <div data-elsewhere="" />
      </TooltipProvider>,
    ));
    // The scroll tracker is shared by every test; let earlier scrolls settle.
    await act(async () => { await wait(200); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  const row = (label: string) => dom.container.querySelector<HTMLElement>(`[data-row="${label}"]`)!;
  const hover = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      element.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
      element.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
      await wait(20);
    });
  };
  const scroll = async (selector: string) => {
    await act(async () => {
      dom.container.querySelector(selector)!.dispatchEvent(new window.Event('scroll'));
      await wait(20);
    });
  };

  test('scrolling the list closes the open row tooltip', async () => {
    await hover(row('first'));
    expect(row('first').hasAttribute('data-popup-open')).toBe(true);

    await scroll('[data-list]');
    expect(row('first').hasAttribute('data-popup-open')).toBe(false);
  });

  test('a row that arrives under the pointer mid-scroll stays closed until the scroll settles', async () => {
    await scroll('[data-list]');
    await hover(row('second'));
    expect(row('second').hasAttribute('data-popup-open')).toBe(false);

    await act(async () => { await wait(200); });
    await hover(row('first'));
    expect(row('first').hasAttribute('data-popup-open')).toBe(true);
  });

  test('scrolling something outside the list leaves the tooltip open', async () => {
    await hover(row('first'));
    await scroll('[data-elsewhere]');
    expect(row('first').hasAttribute('data-popup-open')).toBe(true);
  });
});
