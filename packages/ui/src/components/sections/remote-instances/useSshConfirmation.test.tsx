import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('SSH confirmations settle choices, keep the parent form focusable, and abandon work when leaving', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  window.confirm = () => { throw new Error('Native confirmation must not be used'); };

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { Dialog, DialogContent, DialogTitle } = await import('@/components/ui/dialog');
  const { useSshConfirmation } = await import('./useSshConfirmation');
  const choices: Array<boolean | null> = [];
  function Form({ instanceId }: { instanceId: string }) {
    const { confirm, dialog } = useSshConfirmation(instanceId);
    return (
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>SSH settings</DialogTitle>
          <input aria-label="SSH password" />
          <button onClick={() => {
            void confirm('settings.remoteInstances.page.confirm.storeSshPasswordPlaintext')
              .then((choice) => choices.push(choice));
          }}>Save</button>
          {dialog}
        </DialogContent>
      </Dialog>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (instanceId: string) => act(async () => {
    root.render(<I18nProvider><Form instanceId={instanceId} /></I18nProvider>);
  });
  const button = (text: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === text);
    if (!element) throw new Error(`Missing button: ${text}`);
    return element;
  };
  const click = (text: string) => act(async () => { button(text).click(); });
  try {
    await render('first');
    await click('Save');
    expect(document.body.textContent).toContain('Store SSH password in plaintext on disk?');
    await click('Cancel');
    expect(choices).toEqual([false]);

    const input = document.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Missing password input');
    await act(async () => { input.focus(); });
    expect(document.activeElement).toBe(input);

    await click('Save');
    await click('Save Changes');
    expect(choices).toEqual([false, true]);
    await act(async () => { input.focus(); });
    expect(document.activeElement).toBe(input);

    await click('Save');
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(choices).toEqual([false, true, false]);
    await act(async () => { input.focus(); });
    expect(document.activeElement).toBe(input);

    await click('Save');
    await render('second');
    expect(choices).toEqual([false, true, false, null]);

    await click('Save');
    await act(async () => { root.render(null); });
    expect(choices).toEqual([false, true, false, null, null]);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
