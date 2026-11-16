import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { WorkingPlaceholder } from './WorkingPlaceholder';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

afterAll(() => {
  browser.close();
});

describe('WorkingPlaceholder provider mark', () => {
  test('a chosen provider icon wins over the remote logo', async () => {
    useUIStore.setState({ customProviderIcons: { sharellm: 'server' } });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <WorkingPlaceholder
            isWorking
            status={{ key: 'chat.agentStatus.thinking' }}
            providerId="sharellm"
          />
        </I18nProvider>,
      );
    });

    const mark = container.querySelector('use');
    expect(mark?.getAttribute('href')).toBe('#oc-server');
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    useUIStore.setState({ customProviderIcons: {} });
  });

  test('a failed remote logo leaves the chip empty and is not announced', async () => {
    useUIStore.setState({ customProviderIcons: {} });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <WorkingPlaceholder
            isWorking
            status={{ key: 'chat.agentStatus.thinking' }}
            providerId="sharellm"
          />
        </I18nProvider>,
      );
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('use')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
