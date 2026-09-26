import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { shortcutRegistry } from '@/lib/shortcuts';
import { sessionHistory } from '@/lib/sessionNavigationHistory';
import { SessionHistoryControls } from './SessionHistoryControls';

const installDom = () => {
  const window = new Window({ url: 'http://localhost' });
  const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement',
    'HTMLButtonElement', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window, document: window.document, navigator: window.navigator,
    Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement, KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent, FocusEvent: window.FocusEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of names) Object.defineProperty(globalThis, name, {
    value: values[name], configurable: true, writable: true,
  });
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};

type MountedControls = {
  container: HTMLDivElement;
  back: () => HTMLButtonElement;
  trigger: () => HTMLElement;
  unmount: () => Promise<void>;
};

const mountControls = async (): Promise<MountedControls> => {
  const restore = installDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider><TooltipProvider><SessionHistoryControls /></TooltipProvider></I18nProvider>,
    );
  });
  const back = () => {
    const node = container.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    if (!node) throw new Error('Missing history controls');
    return node;
  };
  const trigger = () => {
    const node = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
    if (!node) throw new Error('Missing tooltip trigger');
    return node;
  };
  return {
    container,
    back,
    trigger,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
      restore();
    },
  };
};

test('buttons reflect availability and invoke only the enabled direction', async () => {
  let backCalls = 0;
  let forwardCalls = 0;
  const stopBack = shortcutRegistry.register('navigate_session_back', () => { backCalls += 1; });
  const stopForward = shortcutRegistry.register('navigate_session_forward', () => { forwardCalls += 1; });
  sessionHistory.setScope('controls-fixture');
  sessionHistory.setBlocked(false);
  sessionHistory.record({ sessionId: 'A', directory: '/a' });
  const mounted = await mountControls();
  try {
    const back = mounted.back();
    const forward = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Forward"]');
    if (!forward) throw new Error('Missing history controls');
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);
    await act(async () => { sessionHistory.record({ sessionId: 'B', directory: '/b' }); });
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
    await act(async () => { back.click(); forward.click(); });
    expect([backCalls, forwardCalls]).toEqual([1, 0]);
    await act(async () => { sessionHistory.setBlocked(true); });
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);
  } finally {
    await mounted.unmount();
    stopBack(); stopForward();
    sessionHistory.setScope('controls-cleanup');
    sessionHistory.setBlocked(false);
  }
});

test('keeps the button and trigger nodes across availability changes', async () => {
  sessionHistory.setScope('controls-identity');
  sessionHistory.setBlocked(false);
  sessionHistory.record({ sessionId: 'A', directory: '/a' });
  const mounted = await mountControls();
  try {
    const back = mounted.back();
    const trigger = mounted.trigger();
    expect(back.disabled).toBe(true);
    expect(trigger.contains(back)).toBe(true);

    await act(async () => { sessionHistory.record({ sessionId: 'B', directory: '/b' }); });
    expect(mounted.container.querySelector('button[aria-label="Back"]')).toBe(back);
    expect(mounted.container.querySelector('[data-slot="tooltip-trigger"]')).toBe(trigger);
    expect(back.disabled).toBe(false);
    expect(trigger.contains(back)).toBe(true);

    await act(async () => { sessionHistory.setBlocked(true); });
    expect(mounted.container.querySelector('button[aria-label="Back"]')).toBe(back);
    expect(mounted.container.querySelector('[data-slot="tooltip-trigger"]')).toBe(trigger);
    expect(back.disabled).toBe(true);

    await act(async () => { sessionHistory.setBlocked(false); });
    expect(mounted.container.querySelector('button[aria-label="Back"]')).toBe(back);
    expect(back.disabled).toBe(false);
  } finally {
    await mounted.unmount();
    sessionHistory.setScope('controls-identity-cleanup');
    sessionHistory.setBlocked(false);
  }
});

test('history controls opt into the accent focus ring and receive keyboard focus', async () => {
  sessionHistory.setScope('controls-focus-ring');
  sessionHistory.setBlocked(false);
  sessionHistory.record({ sessionId: 'A', directory: '/a' });
  sessionHistory.record({ sessionId: 'B', directory: '/b' });
  const mounted = await mountControls();
  try {
    const back = mounted.back();
    const forward = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Forward"]');
    if (!forward) throw new Error('Missing history controls');
    // The app-wide focus reset suppresses every outline unless a control opts in
    // through the design system's accent ring. The painted ring is verified in a
    // real browser (this harness loads no stylesheet); this guards the opt-in and
    // the focus path itself.
    expect([back, forward].map((button) => button.getAttribute('data-focus-ring')))
      .toEqual(['accent', 'accent']);
    await act(async () => { back.focus(); });
    expect(document.activeElement).toBe(back);
    expect(back.matches(':focus-visible')).toBe(true);
  } finally {
    await mounted.unmount();
    sessionHistory.setScope('controls-focus-ring-cleanup');
    sessionHistory.setBlocked(false);
  }
});

test('tooltip opens for pointer hover and keyboard focus', async () => {
  sessionHistory.setScope('controls-tooltip');
  sessionHistory.setBlocked(false);
  sessionHistory.record({ sessionId: 'A', directory: '/a' });
  sessionHistory.record({ sessionId: 'B', directory: '/b' });
  const mounted = await mountControls();
  try {
    const back = mounted.back();
    const trigger = mounted.trigger();
    // Base UI popups do not render in this DOM harness, so the observable
    // contract is the trigger's open state driven by each interaction path.
    const open = () => trigger.hasAttribute('data-popup-open');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    expect(open()).toBe(false);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseenter'));
      await settle();
    });
    expect(open()).toBe(true);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseleave'));
      await settle();
    });
    expect(open()).toBe(false);
    await act(async () => {
      back.focus();
      back.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      await settle();
    });
    expect(open()).toBe(true);
  } finally {
    await mounted.unmount();
    sessionHistory.setScope('controls-tooltip-cleanup');
    sessionHistory.setBlocked(false);
  }
});
