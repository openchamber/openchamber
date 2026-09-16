import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useResolvedModelStore } from '@/stores/resolvedModelStore';
import { ResolvedModelBadge } from './ResolvedModelBadge';

const renderBadge = async (sessionId: string | null) => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    // floating-ui's element checks read these off the global scope.
    Element: win.Element,
    Node: win.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ResolvedModelBadge sessionId={sessionId} />
      </I18nProvider>,
    ));
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
};

const withEntries = (entries: Array<[string, { sessionId: string; model: string; updatedAt: number }]>) => {
  useResolvedModelStore.setState({ bySessionId: new Map(entries) });
};

describe('ResolvedModelBadge', () => {
  test('renders nothing without a resolved model', async () => {
    withEntries([]);
    expect(await renderBadge('ses_1')).toBe('');
  });

  test('renders nothing for a session with no report', async () => {
    withEntries([['ses_1', { sessionId: 'ses_1', model: 'hosted_vllm/deepseek-ai/DeepSeek-V4.1-Flash', updatedAt: 1 }]]);
    expect(await renderBadge('ses_2')).toBe('');
  });

  test('renders nothing without a session', async () => {
    withEntries([['ses_1', { sessionId: 'ses_1', model: 'hosted_vllm/deepseek-ai/DeepSeek-V4.1-Flash', updatedAt: 1 }]]);
    expect(await renderBadge(null)).toBe('');
  });

  test('shows the model name without the gateway prefix', async () => {
    withEntries([['ses_1', { sessionId: 'ses_1', model: 'hosted_vllm/deepseek-ai/DeepSeek-V4.1-Flash', updatedAt: 1 }]]);

    const markup = await renderBadge('ses_1');

    expect(markup).toContain('DeepSeek-V4.1-Flash');
    expect(markup).not.toContain('hosted_vllm');
    expect(markup).not.toContain('deepseek-ai/');
  });
});
