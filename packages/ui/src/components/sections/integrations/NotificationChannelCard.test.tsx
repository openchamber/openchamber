import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { NotificationChannel } from '@/lib/notifications/channels';

describe('NotificationChannelCard', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  const globals = new Map<string, PropertyDescriptor | undefined>();

  // A Slack-like channel: a fixed server, a bearer token with scopes and a page where one is made.
  const slack: NotificationChannel = {
    providerId: 'ext-slack-bridge',
    guestId: 'slack-bridge',
    name: 'Slack Bridge',
    channel: {
      label: 'Slack',
      instances: { kind: 'fixed', origin: 'https://slack.com' },
      token: { scheme: 'bearer', username: false, scopes: ['chat:write'], createPath: '/apps' },
    },
    account: null,
  };
  // A Matrix-like channel: the user types the homeserver, and the token page lives on it.
  const matrix: NotificationChannel = {
    providerId: 'ext-matrix-bridge',
    guestId: 'matrix-bridge',
    name: 'Matrix Bridge',
    channel: {
      label: 'Matrix',
      instances: { kind: 'user', label: 'Homeserver', placeholder: 'https://matrix.example.org' },
      token: { scheme: 'bearer', username: false, scopes: [], createPath: '/_matrix/tokens' },
    },
    account: null,
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement, DocumentFragment: dom.DocumentFragment,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, Event: dom.Event,
      CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    await dom.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const mount = async (channel: NotificationChannel) => {
    const { createRoot } = await import('react-dom/client');
    const { NotificationChannelCard } = await import('./NotificationChannelCard');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(
        <I18nProvider>
          <TooltipProvider>
            <NotificationChannelCard channel={channel} guest={null} onChanged={async () => {}} />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!trigger) throw new Error('Missing channel card trigger');
    await act(async () => { trigger.click(); });
  };

  const buttonLabels = () => [...container.querySelectorAll('button')].map((entry) => entry.textContent?.trim());

  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  test('names the channel, links to its token page and names the scopes the token needs', async () => {
    await mount(slack);
    expect(container.textContent).toContain('Slack');
    expect(container.textContent).toContain('Not connected');
    expect(buttonLabels()).toContain('Create token');
    expect(container.textContent).toContain('chat:write');
    expect(buttonLabels()).toContain('Connect');
    expect(buttonLabels()).not.toContain('Disconnect');
  });

  test('a user-typed server gets its token link once the address is one, and shows the account it is connected as', async () => {
    await mount(matrix);
    expect(buttonLabels()).not.toContain('Create token');
    const address = container.querySelector<HTMLInputElement>('input[placeholder="https://matrix.example.org"]');
    if (!address) throw new Error('Missing homeserver input');
    await type(address, 'https://matrix.example.org');
    expect(buttonLabels()).toContain('Create token');
    await act(async () => { root?.unmount(); });
    root = undefined;

    await mount({
      ...matrix,
      account: { instance: 'https://matrix.example.org', account: { id: '@mona:example.org', login: 'mona', connectedAt: 1, status: 'valid' } },
    });
    expect(container.textContent).toContain('mona');
    expect(container.textContent).toContain('https://matrix.example.org');
    // Connecting again keeps the server: the field starts with the account's.
    expect(container.querySelector<HTMLInputElement>('input[placeholder="https://matrix.example.org"]')?.value).toBe('https://matrix.example.org');
    expect(buttonLabels()).toContain('Disconnect');
    expect(buttonLabels()).toContain('Connect again');
    expect(buttonLabels()).toContain('Create token');
  });

  test('a written-off account stays listed and says what to do', async () => {
    await mount({
      ...slack,
      account: { instance: 'https://slack.com', account: { id: 'U1', login: 'mona', connectedAt: 1, status: 'invalid', invalidReason: 'unauthorized' } },
    });
    expect(container.textContent).toContain('Account needs attention');
    expect(container.textContent).toContain('Slack refused');
    expect(buttonLabels()).toContain('Connect again');
    await act(async () => { root?.unmount(); });
    root = undefined;

    await mount({
      ...slack,
      account: { instance: 'https://old.slack.com', account: { id: 'U1', login: 'mona', connectedAt: 1, status: 'invalid', invalidReason: 'instance-changed' } },
    });
    expect(container.textContent).toContain('Account needs attention');
    expect(container.textContent).toContain('different server');
  });
});
