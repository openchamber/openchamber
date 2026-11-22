import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';

import { MobileToaster } from './MobileToaster';

describe('MobileToaster', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let viewport: InstanceType<Window['EventTarget']> & { offsetTop: number };

  // Where the toast list sits on a phone, as sonner's mobile CSS reads it.
  const toastList = () => document.querySelector<HTMLElement>('[data-sonner-toaster]');
  // The pan as the toast list inherits it from the nearest element that sets it.
  const visualViewportTop = () => {
    for (let element = toastList(); element; element = element.parentElement) {
      const value = element.style.getPropertyValue('--oc-visual-viewport-offset-top');
      if (value) return value;
    }
    return '';
  };

  const scrollVisibleArea = async (offsetTop: number) => {
    viewport.offsetTop = offsetTop;
    await act(async () => {
      viewport.dispatchEvent(new windowInstance.Event('scroll'));
    });
  };

  beforeEach(async () => {
    windowInstance = new Window({ width: 390, height: 844 });
    viewport = Object.assign(new windowInstance.EventTarget(), { offsetTop: 0 });
    Object.defineProperty(windowInstance, 'visualViewport', { value: viewport });
    Object.assign(globalThis, {
      Event: windowInstance.Event, CustomEvent: windowInstance.CustomEvent,
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<MobileToaster />));
    await act(async () => {
      toast.info('Large paste');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    toast.dismiss();
    windowInstance.close();
  });

  test('anchors phone toasts to the visible area below the notch', () => {
    expect(toastList()?.style.getPropertyValue('--mobile-offset-top')).toBe('calc(var(--oc-safe-area-top, 0px) + var(--oc-visual-viewport-offset-top, 0px) + 16px)');
  });

  test('follows the visible area when the keyboard pans it down', async () => {
    expect(visualViewportTop()).toBe('0px');

    await scrollVisibleArea(312.4);
    expect(visualViewportTop()).toBe('312px');

    await scrollVisibleArea(0);
    expect(visualViewportTop()).toBe('0px');
  });
});
