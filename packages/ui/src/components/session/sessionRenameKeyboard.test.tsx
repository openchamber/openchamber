import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import { handleSessionRenameKeyDown } from './sessionRenameKeyboard';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');

function fixture() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: string[] = [];
  let cancelled = 0;
  let bubbled = 0;
  flushSync(() => root.render(
    <div onKeyDown={() => { bubbled += 1; }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector('input');
        if (input) saved.push(input.value);
      }}>
        <input defaultValue="Updated session title" onKeyDown={(event) => handleSessionRenameKeyDown(event, () => { cancelled += 1; })} />
        <button type="submit">Save</button>
      </form>
    </div>,
  ));
  const input = container.querySelector('input');
  if (!input) throw new Error('Missing rename input');
  const key = (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    return event;
  };
  return { saved, key, cancelled: () => cancelled, bubbled: () => bubbled, cleanup: () => { flushSync(() => root.unmount()); container.remove(); } };
}

test('Enter submits the current title from keydown alone and prevents a second native submit', () => {
  const form = fixture();
  try {
    expect(form.key('Enter').defaultPrevented).toBe(true);
    expect(form.saved).toEqual(['Updated session title']);
    expect(form.bubbled()).toBe(0);
    expect(form.key('Enter', { repeat: true }).defaultPrevented).toBe(true);
    expect(form.saved).toHaveLength(1);
  } finally { form.cleanup(); }
});

test('IME confirmation and its WebKit fallback do not save or cancel the rename', () => {
  const form = fixture();
  try {
    for (const key of ['Enter', 'Escape']) {
      expect(form.key(key, { isComposing: true }).defaultPrevented).toBe(false);
      expect(form.key(key, { keyCode: 229 }).defaultPrevented).toBe(false);
    }
    expect(form.saved).toHaveLength(0);
    expect(form.cancelled()).toBe(0);
  } finally { form.cleanup(); }
});

test('Escape cancels and ordinary text input retains its default behavior', () => {
  const form = fixture();
  try {
    expect(form.key('a').defaultPrevented).toBe(false);
    expect(form.key('Escape').defaultPrevented).toBe(true);
    expect(form.cancelled()).toBe(1);
    expect(form.saved).toHaveLength(0);
  } finally { form.cleanup(); }
});
