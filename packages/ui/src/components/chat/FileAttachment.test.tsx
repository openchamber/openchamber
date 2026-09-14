import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useInputStore } from '@/sync/input-store';
import { AttachedFilesList } from './FileAttachment';

test('keeps submitted attachments visible and blocks removal while pending', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  useInputStore.setState({
    attachedFiles: [{
      id: 'file-1',
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      source: 'local',
      dataUrl: 'data:text/plain;base64,aGVsbG8=',
    }],
  });

  try {
    await act(async () => root.render(
      <I18nProvider>
        <AttachedFilesList disabled />
      </I18nProvider>,
    ));

    expect(container.textContent).toContain('notes.txt');
    const remove = container.querySelector<HTMLElement>('[data-remove-button]');
    expect(remove?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { remove?.click(); });
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['file-1']);
  } finally {
    await act(async () => root.unmount());
    useInputStore.setState({ attachedFiles: [] });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
