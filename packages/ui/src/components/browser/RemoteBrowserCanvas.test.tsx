import { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { dom, mountCanvas } from './RemoteBrowserCanvas.test-support';

describe('RemoteBrowserCanvas native input', () => {
  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    test(`keeps ${modifier === 'ctrlKey' ? 'Ctrl' : 'Command'} shortcuts inside the remote page`, async () => {
      // Given the remote page has keyboard focus and the host listens for application shortcuts.
      const { socket, canvas } = await mountCanvas();
      const stage = canvas.parentElement;
      if (!(stage instanceof HTMLElement)) throw new Error('Expected the remote browser stage');
      let hostShortcutCount = 0;
      const hostShortcut = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() === 'p' && event[modifier]) hostShortcutCount += 1;
      };
      window.addEventListener('keydown', hostShortcut);
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'p',
        [modifier]: true,
      });
      try {
        // When the user invokes Chrome's print shortcut in the remote page.
        await act(async () => { stage.dispatchEvent(event); });
      } finally {
        window.removeEventListener('keydown', hostShortcut);
      }

      // Then Chrome receives it while the host command palette listener does not.
      expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
        { type: 'key', eventType: 'keydown', key: 'p', modifiers: [modifier === 'ctrlKey' ? 'Control' : 'Meta'], tabId: 'sc:target' },
      ]);
      expect(event.defaultPrevented).toBe(true);
      expect(hostShortcutCount).toBe(0);
    });
  }

  test('leaves host shortcuts active outside the remote page input boundary', async () => {
    // Given a regular host control beside the remote page and a host shortcut listener.
    const { socket, button } = await mountCanvas();
    let hostShortcutCount = 0;
    const hostShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'p' && event.ctrlKey) hostShortcutCount += 1;
    };
    window.addEventListener('keydown', hostShortcut);
    try {
      // When the regular host control emits Ctrl+P.
      await act(async () => {
        button.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'p',
          ctrlKey: true,
        }));
      });
    } finally {
      window.removeEventListener('keydown', hostShortcut);
    }

    // Then the host still receives the shortcut and the remote page does not.
    expect(hostShortcutCount).toBe(1);
    expect(socket.sent).toEqual([]);
  });

  for (const { name, options, deltaX, deltaY } of [
    { name: 'default pixel', options: {}, deltaX: 4, deltaY: 6 },
    { name: 'line', options: { deltaMode: 1 }, deltaX: 64, deltaY: 96 },
    { name: 'page', options: { deltaMode: 2 }, deltaX: 2000, deltaY: 1500 },
  ]) test(`normalizes ${name} wheel units into remote CSS pixels`, async () => {
    // Given a 1000x500 CSS frame displayed at half-size, captured at DPR 2.
    const { socket, canvas } = await mountCanvas();
    const event = Object.assign(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX: 2, deltaY: 3, ...options,
    }), { clientX: 270, clientY: 155, ctrlKey: true });
    // When the browser delivers its native wheel event.
    await act(async () => { canvas.dispatchEvent(event); });
    // Then page coordinates and deltas each convert once, independently of DPR.
    expect(event.defaultPrevented).toBe(true);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'wheel', x: 500, y: 250, deltaX, deltaY, modifiers: ['Control'], tabId: 'sc:target' },
    ]);
  });

  test('sends a wheel gesture without pointer clicks when a touch swipes', async () => {
    // Given a rendered remote page.
    const { socket, canvas } = await mountCanvas();
    // When one touch moves up far enough to scroll and is released.
    await act(async () => {
      for (const [type, y] of [['pointerdown', 180], ['pointermove', 140], ['pointerup', 140]] as const) {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, clientX: 170, clientY: y,
        }));
      }
    });
    // Then only the remote scroll is emitted.
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'wheel', x: 300, y: 220, deltaX: 0, deltaY: 80, tabId: 'sc:target' },
    ]);
  });

  test('sends a pointer click when a touch taps without scrolling', async () => {
    // Given a rendered remote page.
    const { socket, canvas } = await mountCanvas();
    // When one touch presses and releases in place.
    await act(async () => {
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 8, clientX: 170, clientY: 180,
        }));
      }
    });
    // Then the page receives exactly one down/up pair at remote CSS coordinates.
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'pointer', eventType: 'down', x: 300, y: 300, button: 0, tabId: 'sc:target' },
      { type: 'pointer', eventType: 'up', x: 300, y: 300, button: 0, tabId: 'sc:target' },
    ]);
  });

  test('focuses the real text input when the keyboard button is clicked', async () => {
    // Given the on-screen keyboard control.
    const { input, button } = await mountCanvas();
    // When the user clicks it.
    await act(async () => button.click());
    // Then a focusable textarea owns the caret required by mobile keyboards.
    expect(dom.document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
  });

  test('reports the canvas fit scale from rendered frame geometry', async () => {
    const scales: Array<number | null> = [];
    await mountCanvas({ onDisplayScaleChange: (scale) => { scales.push(scale); } });

    expect(scales.at(-1)).toBe(0.5);
  });

  test('forwards committed native input once and resets its local buffer', async () => {
    // Given a focused mobile text input.
    const { socket, input, button } = await mountCanvas();
    await act(async () => button.click());
    // When the native keyboard commits text.
    await act(async () => {
      input.value = ' hello';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: 'hello', isComposing: false,
      }));
    });
    // Then the remote browser receives the text once and the caret stays ready.
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'text', text: 'hello', tabId: 'sc:target' },
    ]);
    expect(input.value).toBe(' ');
    expect(input.selectionStart).toBe(1);
  });

  for (const finalInput of [false, true]) test(`forwards an IME composition once ${finalInput ? 'with' : 'without'} a final input`, async () => {
    // Given a focused text input with an in-progress native IME composition.
    const { socket, input, button } = await mountCanvas();
    await act(async () => button.click());
    // When the IME supplies intermediate text, then commits it with its final input.
    await act(async () => {
      input.dispatchEvent(Object.assign(new CompositionEvent('compositionstart', { bubbles: true }), { data: '' }));
      input.value = ' 日本';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertCompositionText', data: '日本', isComposing: true,
      }));
      expect(socket.sent).toEqual([]);
      input.dispatchEvent(Object.assign(new CompositionEvent('compositionend', { bubbles: true }), { data: '日本' }));
      if (finalInput) {
        input.value = ' 日本';
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertFromComposition', data: '日本', isComposing: false,
        }));
      }
    });
    // Then the committed text is inserted exactly once in the remote browser.
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'text', text: '日本', tabId: 'sc:target' },
    ]);
  });

  test('preserves a regular insertion matching the preceding IME text', async () => {
    // Given a completed IME commit.
    const { socket, input, button } = await mountCanvas();
    await act(async () => {
      button.click();
      input.dispatchEvent(Object.assign(new CompositionEvent('compositionend', { bubbles: true }), { data: 'a' }));
      input.value = ' a';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertFromComposition', data: 'a', isComposing: false,
      }));
    });
    // When a subsequent regular key inserts the same character.
    await act(async () => {
      input.value = ' a';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: 'a', isComposing: false,
      }));
    });
    // Then the genuine second insertion is retained.
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'text', text: 'a', tabId: 'sc:target' },
      { type: 'text', text: 'a', tabId: 'sc:target' },
    ]);
  });

  for (const [inputType, key] of [['deleteContentBackward', 'Backspace'], ['deleteContentForward', 'Delete']]) {
    test(`forwards native ${inputType} as remote key events`, async () => {
      // Given the focused mobile keyboard buffer.
      const { socket, input, button } = await mountCanvas();
      await act(async () => button.click());
      const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType });
      // When the native keyboard requests deletion.
      await act(async () => { input.dispatchEvent(event); });
      // Then the remote key is pressed and released without deleting the local sentinel.
      expect(event.defaultPrevented).toBe(true);
      expect(input.value).toBe(' ');
      expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
        { type: 'key', eventType: 'keydown', key, tabId: 'sc:target' },
        { type: 'key', eventType: 'keyup', key, tabId: 'sc:target' },
      ]);
    });
  }
});
