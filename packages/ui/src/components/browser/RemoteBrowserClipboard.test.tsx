import { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { dom, mountCanvas } from './RemoteBrowserCanvas.test-support';

const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, 'clipboard');
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(dom.navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(dom.navigator, 'clipboard');
});
const setClipboard = (clipboard: Partial<Clipboard>) => Object.defineProperty(dom.navigator, 'clipboard', { configurable: true, value: clipboard });
const buttonNamed = (name: string) => {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === name);
  if (!button) throw new Error(`Expected ${name} button`);
  return button;
};
const copyRequestSchema = z.object({ type: z.literal('copy'), requestId: z.string(), tabId: z.string() });
const copyRequest = (sent: string[]) => {
  for (const message of sent) {
    const result = copyRequestSchema.safeParse(JSON.parse(message));
    if (result.success) return result.data;
  }
  throw new Error('Expected a selection request');
};

describe('RemoteBrowserClipboard', () => {
  for (const targetName of ['stage', 'input'] as const) {
    for (const modifier of ['ctrlKey', 'metaKey'] as const) test(`copies remote selection from ${targetName} with ${modifier} and retains native select-all`, async () => {
    const { canvas, input, socket } = await mountCanvas();
    const stage = targetName === 'input' ? input : canvas.parentElement;
    if (!stage) throw new Error('Expected remote stage');
    const values: string[] = [];
    let writes = 0;
    setClipboard({ write: async (items) => { writes += 1; values.push(await (await items[0].getType('text/plain')).text()); } });
    const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'c', [modifier]: true });
    await act(async () => {
      stage.dispatchEvent(down);
      stage.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'c', [modifier]: true }));
    });
    expect(down.defaultPrevented).toBe(true);
    expect(writes).toBe(1);
    const request = copyRequest(socket.sent);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([request]);
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: true, text: 'remote 日本語\nselection' }) });
    });
    expect(values).toEqual(['remote 日本語\nselection']);
    socket.sent.length = 0;
    await act(async () => {
      stage.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', [modifier]: true }));
    });
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'key', eventType: 'keydown', key: 'a', modifiers: [modifier === 'ctrlKey' ? 'Control' : 'Meta'], tabId: 'sc:target' },
    ]);
  });
  }

  test('reads the local clipboard only from the explicit paste button', async () => {
    let reads = 0;
    setClipboard({ readText: async () => { reads += 1; return 'pasted 日本語\nplain'; } });
    const { socket } = await mountCanvas();
    expect(reads).toBe(0);
    await act(async () => buttonNamed('Paste').click());
    expect(reads).toBe(1);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'text', text: 'pasted 日本語\nplain', tabId: 'sc:target' },
    ]);
  });

  test('keeps denied paste local until the user submits the dialog', async () => {
    setClipboard({ readText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    const { socket } = await mountCanvas();
    await act(async () => buttonNamed('Paste').click());
    const dialog = document.querySelector('[role="dialog"]');
    const input = dialog?.querySelector('textarea');
    if (!dialog || !input) throw new Error('Expected local paste dialog');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'manual text');
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'v', ctrlKey: true }));
      input.dispatchEvent(paste);
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'v', ctrlKey: true }));
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'manual text');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'manual text', inputType: 'insertFromPaste' }));
    });
    expect(paste.defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);
    const submit = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Paste');
    if (!submit) throw new Error('Expected paste submission');
    await act(async () => submit.click());
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'text', text: 'manual text', tabId: 'sc:target' },
    ]);
  });

  test('exposes only requested selection when clipboard write is denied', async () => {
    setClipboard({ write: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    const { socket } = await mountCanvas();
    await act(async () => buttonNamed('Copy').click());
    const request = copyRequest(socket.sent);
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: true, text: 'selected only' }) }));
    const input = document.querySelector('[role="dialog"] textarea');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('Expected selection fallback');
    expect(input.value).toBe('selected only');
    expect(input.readOnly).toBe(true);
    socket.sent.length = 0;
    const copy = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(copy); });
    expect(copy.defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  for (const change of ['tab', 'disabled', 'stop'] as const) test(`ignores a delayed paste after ${change}`, async () => {
    let resolveText: (text: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => { resolveText = resolve; });
    setClipboard({ readText: () => pending });
    const { socket, render, client } = await mountCanvas();
    await act(async () => buttonNamed('Paste').click());
    if (change === 'tab') await render('sc:other');
    if (change === 'disabled') await render('sc:target', false);
    if (change === 'stop') client.stop();
    await act(async () => resolveText('must not arrive'));
    expect(socket.sent).toEqual([]);
  });

  test('rejects the promised clipboard value after the selected tab changes', async () => {
    const values: string[] = [];
    setClipboard({ write: async (items) => { values.push(await (await items[0].getType('text/plain')).text()); } });
    const { socket, render } = await mountCanvas();
    await act(async () => buttonNamed('Copy').click());
    const request = copyRequest(socket.sent);
    await render('sc:other');
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: true, text: 'stale selection' }) }));
    expect(values).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  for (const [code, feedback] of [
    ['NO_SELECTION', 'Select text on the page to copy.'],
    ['COPY_TOO_LARGE', 'This text is too large to transfer.'],
    ['COPY_FAILED', 'Could not copy the selection. Try again.'],
  ] as const) test(`shows useful feedback for ${code} without replacing the clipboard`, async () => {
    const values: string[] = [];
    setClipboard({ write: async (items) => { values.push(await (await items[0].getType('text/plain')).text()); } });
    const { socket } = await mountCanvas();
    await act(async () => buttonNamed('Copy').click());
    const request = copyRequest(socket.sent);
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: false, code, message: 'server detail' }) }));
    expect(document.querySelector('[role="status"]')?.textContent).toBe(feedback);
    expect(values).toEqual([]);
    expect(buttonNamed('Copy').disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('uses the existing text-copy fallback when ClipboardItem writes are unavailable', async () => {
    const values: string[] = [];
    setClipboard({ writeText: async (text) => { values.push(text); } });
    const { socket } = await mountCanvas();
    await act(async () => buttonNamed('Copy').click());
    const request = copyRequest(socket.sent);
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: true, text: 'legacy text' }) }));
    expect(values).toEqual(['legacy text']);
  });

  test('does not write a fallback selection after its remote connection stops', async () => {
    setClipboard({ write: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    const { socket, client } = await mountCanvas();
    await act(async () => buttonNamed('Copy').click());
    const request = copyRequest(socket.sent);
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ ...request, type: 'copyResult', ok: true, text: 'old selection' }) }));
    const dialog = document.querySelector('[role="dialog"]');
    const retry = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent === 'Copy');
    if (!retry) throw new Error('Expected copy retry');
    const values: string[] = [];
    setClipboard({ writeText: async (text) => { values.push(text); } });
    client.stop();
    await act(async () => retry.click());
    expect(values).toEqual([]);
  });
});
