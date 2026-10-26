import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Node: dom.Node,
  Event: dom.Event,
  InputEvent: dom.InputEvent,
  KeyboardEvent: dom.KeyboardEvent,
  DOMRect: dom.DOMRect,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// After the globals: react-dom reads whether it runs in a browser when it loads.
const { createRoot } = await import('react-dom/client');
const { Textarea } = await import('@/components/ui/textarea');
const { I18nProvider } = await import('@/lib/i18n');
const { loadEmojiTable } = await import('@/lib/emoji/shortcodes');

afterAll(() => dom.happyDOM.close());

let value = '';
let submitted = 0;
let panelEscapes = 0;
const Harness = () => {
  const [text, setText] = React.useState('');
  value = text;
  // A panel that closes on Escape from its capture phase, as the context panel does.
  return (
    <div onKeyDownCapture={(event) => { if (event.key === 'Escape') panelEscapes++; }}>
    <Textarea
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') submitted++;
      }}
    />
    </div>
  );
};

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
const field = host.querySelector('textarea');
if (!field) throw new Error('textarea did not render');

const type = async (text: string, inputType = 'insertText') => {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, text);
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  });
  await act(async () => { await loadEmojiTable(); });
};
const press = (key: string) => act(async () => {
  field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});
const options = () => Array.from(document.body.querySelectorAll('.oc-glass-popover .cursor-pointer')).map((row) => row.textContent);

test('a typed :query lists emoji, and Enter writes the chosen one instead of reaching the field', async () => {
  await loadEmojiTable();
  await type('shipped :tad');
  expect(options()[0]).toBe('🎉:tada:');
  await press('Enter');
  expect(value).toBe('shipped 🎉 ');
  expect(submitted).toBe(0);
  expect(options()).toEqual([]);
});

test('without a match or after Escape the field gets its keys back', async () => {
  await type('a :zzzzqq');
  expect(options()).toEqual([]);
  await press('Enter');
  expect(submitted).toBe(1);

  await type('a :rock');
  expect(options().length).toBeGreaterThan(0);
  await press('Escape');
  expect(options()).toEqual([]);
  expect(panelEscapes).toBe(0);
  await press('Enter');
  expect(submitted).toBe(2);
});

test('a paste ending in :word opens nothing', async () => {
  await type('see :param', 'insertFromPaste');
  expect(options()).toEqual([]);
  await press('Enter');
  expect(submitted).toBe(3);
});
