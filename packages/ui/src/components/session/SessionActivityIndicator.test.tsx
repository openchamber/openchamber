import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { SessionActivityIndicator } from './SessionActivityIndicator';


describe('SessionActivityIndicator', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialAnimatedActivityIndicators: boolean;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];

  const renderIndicator = async (props: React.ComponentProps<typeof SessionActivityIndicator>) => {
    await act(async () => root.render(<I18nProvider><SessionActivityIndicator {...props} /></I18nProvider>));
    return host.innerHTML;
  };

  beforeEach(() => {
    windowInstance = new Window();
    initialAnimatedActivityIndicators = useSessionDisplayStore.getState().animatedActivityIndicators;
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
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
      useSessionDisplayStore.setState({ animatedActivityIndicators: initialAnimatedActivityIndicators });
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const iconHref = (state: string): string | null | undefined => host
    .querySelector(`[data-session-activity-indicator="${state}"] use`)
    ?.getAttribute('href');

  test('gives each state its own static icon when animated indicators are off', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: false });

    await renderIndicator({ state: 'running' });
    expect(iconHref('running')).toBe('#oc-circle');
    await renderIndicator({ state: 'subagent' });
    expect(iconHref('subagent')).toBe('#oc-robot');
    await renderIndicator({ state: 'shell' });
    expect(iconHref('shell')).toBe('#oc-terminal');
    await renderIndicator({ state: 'unread' });
    expect(iconHref('unread')).toBe('#oc-checkbox-circle');
    expect(host.querySelector('[data-session-activity-indicator]')?.classList).toContain('shrink-0');
    expect(host.innerHTML).not.toContain('activity-spinner');
  });

  test('labels the state for assistive technology and hover', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: false });
    await renderIndicator({ state: 'shell' });
    const indicator = host.querySelector('[data-session-activity-indicator="shell"]');
    expect(indicator?.getAttribute('aria-label')).toBe('Command running in the background');
    expect(indicator?.getAttribute('title')).toBe('Command running in the background');
  });

  test('applies running-only classes to running kinds, never to unread', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: false });
    await renderIndicator({ state: 'subagent', runningClassName: 'pulse' });
    expect(host.querySelector('svg')?.classList).toContain('pulse');
    await renderIndicator({ state: 'unread', runningClassName: 'pulse' });
    expect(host.querySelector('svg')?.classList).not.toContain('pulse');
  });

  test('the spinner preference replaces every running kind and keeps the unread icon', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: true });

    for (const state of ['running', 'subagent', 'shell'] as const) {
      await renderIndicator({ state });
      expect(iconHref(state)).toBe('#oc-loader-4');
      expect(host.querySelector('.activity-spinner')).not.toBeNull();
    }
    await renderIndicator({ state: 'unread' });
    expect(iconHref('unread')).toBe('#oc-checkbox-circle');
    expect(host.querySelector('.activity-spinner')).toBeNull();
  });

  test('switches a mounted running indicator immediately and restores the icon', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: false });
    await renderIndicator({ state: 'running' });
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(true));
    expect(host.querySelector('.activity-spinner')?.classList).toContain('text-status-info');
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(false));
    expect(host.querySelector('.activity-spinner')).toBeNull();
    expect(iconHref('running')).toBe('#oc-circle');
  });
});
