import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
    await act(async () => root.render(<SessionActivityIndicator {...props} />));
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

  test('renders a non-shrinking info running dot when animated indicators are off', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: false });

    const markup = await renderIndicator(
      { state: 'running', label: 'Running', runningDotClassName: 'running-dot-class' },
    );
    const indicator = host.querySelector<HTMLElement>('[data-session-activity-indicator="running"]');

    expect(indicator).not.toBeNull();
    expect(indicator?.classList).toContain('bg-[var(--status-info)]');
    expect(indicator?.classList).toContain('running-dot-class');
    expect(indicator?.classList).toContain('shrink-0');
    expect(markup).not.toContain('activity-spinner');
  });

  test('renders a non-shrinking loader-4 spinner when animated running indicators are enabled', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: true });

    await renderIndicator({ state: 'running', label: 'Running' });
    const indicator = host.querySelector<HTMLElement>('[data-session-activity-indicator="running"]');

    expect(indicator).not.toBeNull();
    if (indicator === null) throw new Error('Missing running activity indicator');

    const spinner = indicator.querySelector<SVGSVGElement>('.activity-spinner');
    expect(spinner).not.toBeNull();
    if (spinner === null) throw new Error('Missing running activity spinner');

    const iconUse = spinner.querySelector('use');
    expect(iconUse).not.toBeNull();
    if (iconUse === null) throw new Error('Missing spinner icon use element');

    expect(iconUse.getAttribute('href')).toBe('#oc-loader-4');
    expect(indicator.querySelector('.activity-spinner-fallback')).toBeNull();
    expect(indicator.classList).toContain('shrink-0');
  });

  test('renders a non-shrinking static success dot for unread state when animated indicators are enabled', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: true });

    const markup = await renderIndicator({ state: 'unread', label: 'Unread' });
    const indicator = host.querySelector<HTMLElement>('[data-session-activity-indicator="unread"]');

    expect(indicator).not.toBeNull();
    expect(indicator?.classList).toContain('bg-[var(--status-success)]');
    expect(indicator?.classList).toContain('shrink-0');
    expect(markup).not.toContain('activity-spinner');
  });

  test('switches a mounted running indicator immediately and restores the dot', async () => {
    useSessionDisplayStore.setState({ animatedActivityIndicators: false });
    await renderIndicator({ state: 'running', label: 'Running' });
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(true));
    expect(host.querySelector('.activity-spinner')?.classList).toContain('text-status-info');
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(false));
    expect(host.querySelector('.activity-spinner')).toBeNull();
    expect(host.querySelector('[data-session-activity-indicator]')?.classList).toContain('bg-[var(--status-info)]');
  });
});
