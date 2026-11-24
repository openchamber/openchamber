import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';

import { DraftProjectName } from '@/components/chat/DraftProjectName';
import { requestDraftProjectPicker, useAnswerDraftProjectPicker } from './useDraftProjectPicker';

describe('draft project picker request', () => {
  let dom: Window;
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.close();
  });

  test('a tap on the heading name opens the picker that answers, and the name reports it open', async () => {
    let opens = 0;
    const Picker: React.FC = () => {
      const [open, setOpen] = React.useState(false);
      useAnswerDraftProjectPicker(() => { opens += 1; setOpen(true); }, open);
      return null;
    };

    await act(async () => root.render(<DraftProjectName label="acme" />));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('acme');

    await act(async () => root.render(<><DraftProjectName label="acme" onOpenPicker={requestDraftProjectPicker} /><Picker /></>));
    const button = container.querySelector('button');
    expect(opens).toBe(0);
    expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => button?.click());
    expect(opens).toBe(1);
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => root.render(<DraftProjectName label="acme" onOpenPicker={requestDraftProjectPicker} />));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => container.querySelector('button')?.click());
    expect(opens).toBe(1);
  });

  test('a picker that does not answer neither opens nor reports', async () => {
    let opens = 0;
    const Picker: React.FC = () => {
      useAnswerDraftProjectPicker(null, true);
      return null;
    };
    const Desktop: React.FC = () => {
      useAnswerDraftProjectPicker(() => { opens += 1; }, false);
      return null;
    };

    await act(async () => root.render(<><DraftProjectName label="acme" onOpenPicker={requestDraftProjectPicker} /><Picker /><Desktop /></>));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => container.querySelector('button')?.click());
    expect(opens).toBe(1);
  });
});
