import { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { mountCanvas } from './RemoteBrowserCanvas.test-support';

describe('RemoteBrowserCanvas clipboard events', () => {
  for (const targetName of ['stage', 'input'] as const) test(`copies the remote selection from a native copy event on the ${targetName}`, async () => {
    const { canvas, input, socket } = await mountCanvas();
    const target = targetName === 'input' ? input : canvas.parentElement;
    if (!target) throw new Error('Expected remote keyboard target');
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'copy', requestId: '1', tabId: 'sc:target' },
    ]);
  });

  for (const targetName of ['stage', 'input'] as const) {
    test(`pastes plain text once from a native paste event on the ${targetName}`, async () => {
      // Given a remote keyboard target and a local plain-text clipboard payload.
      const { canvas, input, socket } = await mountCanvas();
      const target = targetName === 'input' ? input : canvas.parentElement;
      if (!target) throw new Error('Expected a keyboard target');
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'line one\n日本語');
      clipboardData.setData('text/html', '<b>not transferred</b>');
      const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
      // When the platform delivers the paste event.
      await act(async () => {
        target.dispatchEvent(paste);
        if (targetName === 'input') {
          input.value = ' line one\n日本語';
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: 'line one\n日本語' }));
        }
      });
      // Then one text command is sent and native insertion is consumed.
      expect(paste.defaultPrevented).toBe(true);
      expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
        { type: 'text', text: 'line one\n日本語', tabId: 'sc:target' },
      ]);
      expect(input.value).toBe(' ');
    });
  }

  test('leaves paste keydown native and never forwards its keyup', async () => {
    // Given the focused remote stage.
    const { canvas, socket } = await mountCanvas();
    const stage = canvas.parentElement;
    if (!stage) throw new Error('Expected stage');
    const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'v', ctrlKey: true });
    // When the shortcut is pressed and released.
    await act(async () => {
      stage.dispatchEvent(down);
      stage.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'v', ctrlKey: true }));
    });
    // Then the browser can deliver paste and no remote shortcut is emitted.
    expect(down.defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test('disables clipboard controls and remote paste when input is disabled', async () => {
    const { canvas, socket, render } = await mountCanvas();
    await render('sc:target', false);
    const stage = canvas.parentElement;
    if (!stage) throw new Error('Expected remote stage');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'disabled');
    await act(async () => {
      stage.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      stage.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'c', ctrlKey: true }));
    });
    expect(socket.sent).toEqual([]);
    expect(stage.querySelector('button')).toBeNull();
  });
});
