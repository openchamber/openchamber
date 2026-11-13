import { SURFACE_FRAME_MAX_BYTES, SURFACE_TEXT_MAX } from '@openchamber/sdk';
import { deviceScale } from './viewports.js';

const BUTTON_NAMES = ['left', 'middle', 'right'];
const KEY_CODES = Object.freeze({
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
});
// Windows virtual key codes of the physical keys that type punctuation (US
// layout positions, which is what `KeyboardEvent.code` names).
const PUNCTUATION_CODES = Object.freeze({
  Space: 32, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
});

// The key code comes from the physical key, as in a real keyboard event. A
// character's own code is wrong for punctuation: '.' is 46, Delete's code, so
// Chrome ran Delete and dropped the '.'; '-', '!' to '(' hit Insert, Page,
// Home/End and the arrows the same way.
const virtualKeyCode = (key, code) => {
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
  const letter = /^Key([A-Z])$/.exec(code ?? '');
  if (letter) return letter[1].charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code ?? '');
  if (digit) return (code.startsWith('Numpad') ? 96 : 48) + Number(digit[1]);
  if (PUNCTUATION_CODES[code] !== undefined) return PUNCTUATION_CODES[code];
  return /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0;
};

const modifiersMask = (modifiers) => (
  (modifiers.alt ? 1 : 0)
  | (modifiers.ctrl ? 2 : 0)
  | (modifiers.meta ? 4 : 0)
  | (modifiers.shift ? 8 : 0)
);

const mouseButton = (button) => BUTTON_NAMES[button] ?? 'none';
// Hosts report a move without a button; Chrome only drags (selects text,
// moves sliders) when the move names the button being held.
const heldButton = (buttons) => (buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none');

const baseCharacter = (key, code) => code === `Key${key.toUpperCase()}` || code === `Digit${key}`;

const dispatchInput = async (page, event) => {
  if (event.type === 'text') {
    await page.cdp.sendSession(page.sessionId, 'Input.insertText', { text: event.text });
    return;
  }
  if (event.type === 'pointer') {
    const types = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' };
    await page.cdp.sendSession(page.sessionId, 'Input.dispatchMouseEvent', {
      type: types[event.action],
      x: event.x,
      y: event.y,
      button: event.action === 'move' ? heldButton(event.buttons) : mouseButton(event.button),
      buttons: event.buttons,
      clickCount: event.action === 'move' ? 0 : 1,
      modifiers: modifiersMask(event.modifiers),
    });
    return;
  }
  if (event.type === 'wheel') {
    await page.cdp.sendSession(page.sessionId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: event.x,
      y: event.y,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiersMask(event.modifiers),
    });
    return;
  }
  const { alt, ctrl, meta, shift } = event.modifiers;
  const keyCode = virtualKeyCode(event.key, event.code);
  const single = [...event.key].length === 1;
  // Option (Mac) and AltGr (Ctrl+Alt on Windows) compose characters. Chords that
  // leave the key on its base character are shortcuts. Linux Chrome refuses to
  // insert text while Ctrl is down, so AltGr text is sent without Ctrl+Alt.
  const composed = single && alt && !baseCharacter(event.key, event.code);
  const modifiers = composed && ctrl ? { alt: false, ctrl: false, meta, shift } : event.modifiers;
  const down = event.action === 'down';
  const text = down && single && !meta && (composed || (!alt && !ctrl)) ? event.key
    : down && event.key === 'Enter' && !alt && !ctrl && !meta ? '\r' : null;
  const selectAll = down && event.key.toLowerCase() === 'a' && (ctrl || meta) && !alt && !shift;
  await page.cdp.sendSession(page.sessionId, 'Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    key: event.key,
    code: event.code,
    modifiers: modifiersMask(modifiers),
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(selectAll ? { commands: ['selectAll'] } : {}),
  });
};

// Follows focus through open shadow roots and same-origin frames. Password
// fields, inaccessible frames, and oversized selections copy nothing.
const clipboardExpression = `(() => {
  let root = document;
  let ownerDocument = document;
  for (let depth = 0; depth < 64; depth += 1) {
    const active = root.activeElement;
    if (active?.tagName === 'IFRAME' || active?.tagName === 'FRAME') {
      const childDocument = active.contentDocument;
      if (!childDocument) return '';
      root = childDocument;
      ownerDocument = childDocument;
      continue;
    }
    if (active?.shadowRoot) {
      root = active.shadowRoot;
      continue;
    }
    let text;
    if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') {
      if (active.type === 'password' || !Number.isInteger(active.selectionStart)
        || !Number.isInteger(active.selectionEnd)
        || active.selectionEnd - active.selectionStart > ${SURFACE_TEXT_MAX}) return '';
      text = active.value.slice(active.selectionStart, active.selectionEnd);
    } else {
      const selection = root.getSelection?.() ?? ownerDocument.getSelection();
      text = selection?.toString() ?? '';
    }
    return text.length > ${SURFACE_TEXT_MAX} ? '' : text;
  }
  return '';
})()`;

const MOTION_QUALITY = 75;
const REFINE_QUALITY = 88;
const REFINE_AFTER_MS = 180;
const REFINE_ECHO_MS = 120;
// While any tab is captured for its sound (tab-audio.js), Chrome shows a
// sharing bar in every tab, and takes it away after; each time the real view
// changes size under the emulated one, and the screencast goes on at the real
// size: the page cut off and shifted, with clicks landing elsewhere. Setting
// the same emulation again and restarting the screencast brings the frames
// back (either alone does not), and the page sees no resize. A frame at
// another size is dropped while that repair runs (frames of the stream a
// resize replaced arrive that way too); should frames keep that size for
// longer anyway, they are shown as they are rather than never.
const SIZE_REPAIR_GAP_MS = 300;
const SIZE_GIVE_UP_MS = 3_000;
// Chrome rounds when it scales a frame to the stream's size.
const SIZE_SLACK_PX = 2;

// The pixel size in a JPEG's frame header, or null. A frame's metadata can
// name the emulated size while its picture is the real view's.
const jpegSize = (bytes) => {
  let offset = 2;
  while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
};

const stopScreencast = (page) => {
  if (page?.cdp.isOpen) void page.cdp.sendSession(page.sessionId, 'Page.stopScreencast').catch(() => {});
};

export const createSurface = (runtime) => {
  const waiters = new Set();
  let page = null;
  let unsubscribe = null;
  let latest = null;
  let sequence = 0;
  let closed = false;
  let startPromise = null;
  // Bumps whenever the runtime's active tab changes.
  let target = 0;
  let swallowEscapeUp = false;
  // The viewport the running screencast was sized for.
  let streamedFor = null;
  // Motion streams at CSS size, which Chrome encodes fast; once the page
  // holds still, one screenshot at the viewer's density replaces the last
  // frame so text is sharp at rest. Anything that happens while that
  // screenshot is taken (a frame, input) makes it stale, and it is dropped.
  let refineTimer = null;
  let changes = 0;
  let refinedAt = 0;
  let repairingSize = false;
  let sizeRepairedAt = 0;
  // When frames started coming at another size; 0 while they fit.
  let offSizeSince = 0;

  const finishWaiter = (waiter, value) => {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(value);
  };

  const publish = (frame) => {
    latest = frame;
    for (const waiter of waiters) {
      if (frame.sequence > waiter.after) finishWaiter(waiter, frame);
    }
  };

  const cancelRefine = () => {
    clearTimeout(refineTimer);
    refineTimer = null;
  };

  const refine = async (current, mark) => {
    const viewport = runtime.viewport;
    if (!viewport || deviceScale(viewport, viewport.scale) <= 1) return;
    // A page paused on a dialog takes no screenshot until it is answered.
    if (runtime.dialogOpen(current.targetId)) return;
    let capture;
    try {
      capture = await current.cdp.sendSession(current.sessionId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: REFINE_QUALITY,
        optimizeForSpeed: true,
      });
    } catch {
      return;
    }
    if (closed || page !== current) return;
    if (changes !== mark) {
      scheduleRefine(current);
      return;
    }
    const bytes = Buffer.from(String(capture.data ?? ''), 'base64');
    if (bytes.length === 0 || bytes.length > SURFACE_FRAME_MAX_BYTES) return;
    refinedAt = Date.now();
    sequence += 1;
    publish({
      sequence,
      bytes,
      mime: 'image/jpeg',
      width: viewport.width,
      height: viewport.height,
      title: runtime.title,
    });
  };

  const scheduleRefine = (current) => {
    cancelRefine();
    const mark = changes;
    refineTimer = setTimeout(() => {
      refineTimer = null;
      void refine(current, mark);
    }, REFINE_AFTER_MS);
    refineTimer.unref?.();
  };

  const detach = () => {
    cancelRefine();
    unsubscribe?.();
    unsubscribe = null;
    stopScreencast(page);
    page = null;
  };

  const repairSize = async (current) => {
    if (repairingSize || Date.now() - sizeRepairedAt < SIZE_REPAIR_GAP_MS) return;
    repairingSize = true;
    try {
      await runtime.reapplyViewport(current.targetId);
      if (closed || page !== current) return;
      detach();
      void start().catch(() => {});
    } catch {
      // The tab went away; the next stream starts from scratch anyway.
    } finally {
      sizeRepairedAt = Date.now();
      repairingSize = false;
    }
  };

  // A frame at another size than the viewport's, while a repair can fix it.
  // The stream is capped at the viewport's CSS size, so the picture has it too.
  const offSize = (current, width, height, bytes) => {
    const viewport = runtime.viewport;
    const picture = jpegSize(bytes);
    const fits = !viewport || (width === viewport.width && height === viewport.height && (!picture || (
      Math.abs(picture.width - viewport.width) <= SIZE_SLACK_PX && Math.abs(picture.height - viewport.height) <= SIZE_SLACK_PX
    )));
    if (fits) {
      offSizeSince = 0;
      return false;
    }
    // A page paused on a dialog keeps its old size until it is answered.
    if (runtime.dialogOpen(current.targetId)) return false;
    const now = Date.now();
    if (offSizeSince === 0) offSizeSince = now;
    if (now - offSizeSince > SIZE_GIVE_UP_MS) return false;
    void repairSize(current);
    return true;
  };

  const startSurface = async () => {
    // A page swapping renderers mid-navigation briefly refuses page commands.
    const retryUntil = Date.now() + 2_000;
    for (;;) {
      const expected = target;
      const current = await runtime.ensurePage();
      if (closed) throw new Error('Surface is closed');
      if (page?.sessionId === current.sessionId && unsubscribe) return current;
      detach();
      page = current;
      unsubscribe = current.cdp.onEvent((event) => {
        if (event.sessionId !== current.sessionId || event.method !== 'Page.screencastFrame') return;
        void current.cdp.sendSession(current.sessionId, 'Page.screencastFrameAck', {
          sessionId: event.params.sessionId,
        }).catch(() => {});
        // Chrome repaints after taking the screenshot; that frame shows the
        // same page, blurrier, so it does not replace the sharp one.
        if (Date.now() - refinedAt < REFINE_ECHO_MS) return;
        const width = Math.round(event.params.metadata?.deviceWidth ?? runtime.viewport?.width ?? 0);
        const height = Math.round(event.params.metadata?.deviceHeight ?? runtime.viewport?.height ?? 0);
        const bytes = Buffer.from(String(event.params.data ?? ''), 'base64');
        if (bytes.length === 0 || bytes.length > SURFACE_FRAME_MAX_BYTES) return;
        if (offSize(current, width, height, bytes)) return;
        changes += 1;
        scheduleRefine(current);
        sequence += 1;
        publish({
          sequence,
          bytes,
          mime: 'image/jpeg',
          width,
          height,
          title: runtime.title,
        });
      });
      try {
        const viewport = runtime.viewport;
        const scale = viewport ? deviceScale(viewport, viewport.scale) : 1;
        streamedFor = viewport ? `${viewport.width}x${viewport.height}@${scale}` : null;
        await current.cdp.sendSession(current.sessionId, 'Page.startScreencast', {
          format: 'jpeg',
          quality: MOTION_QUALITY,
          everyNthFrame: 1,
          ...(viewport ? { maxWidth: viewport.width, maxHeight: viewport.height } : {}),
        });
      } catch (error) {
        detach();
        if (closed || Date.now() > retryUntil) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (closed) {
        detach();
        throw new Error('Surface is closed');
      }
      if (expected === target) return current;
      // The active tab changed while this stream started (opening the first
      // page does that too); drop it so the next pass streams from scratch.
      detach();
    }
  };

  const start = () => {
    if (closed) return Promise.reject(new Error('Surface is closed'));
    if (!startPromise) startPromise = startSurface().catch((error) => {
      unsubscribe?.();
      unsubscribe = null;
      page = null;
      throw error;
    }).finally(() => { startPromise = null; });
    return startPromise;
  };

  return {
    async frame({ after, wait, signal }) {
      if (closed) return null;
      signal?.throwIfAborted();
      await start();
      signal?.throwIfAborted();
      if (latest && latest.sequence > after) return latest;
      if (wait === 0) return null;
      return new Promise((resolve, reject) => {
        const waiter = { after, signal, resolve, reject, timer: null, onAbort: null };
        waiter.onAbort = () => {
          if (!waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          reject(signal.reason ?? new DOMException('Frame request cancelled', 'AbortError'));
        };
        waiter.timer = setTimeout(() => finishWaiter(waiter, null), wait);
        waiter.timer.unref?.();
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        waiters.add(waiter);
      });
    },
    async input(events, theme = null) {
      const current = await start();
      // Input usually changes the page: a screenshot in flight is stale.
      changes += 1;
      if (refineTimer) scheduleRefine(current);
      const menu = runtime.contextMenu;
      for (const event of events) {
        if (event.type === 'key' && event.key === 'Escape' && event.action === 'up' && swallowEscapeUp) {
          swallowEscapeUp = false;
          continue;
        }
        const secondary = event.type === 'pointer' && event.button === 2;
        if (menu.isOpen) {
          // Escape and the wheel only dismiss the menu; other keys and a new
          // right click dismiss it and go on to the page.
          const dismissOnly = event.type === 'wheel' || (event.type === 'key' && event.key === 'Escape');
          if (dismissOnly || event.type === 'key' || (secondary && event.action === 'down')) await menu.close();
          if (dismissOnly) {
            swallowEscapeUp = event.type === 'key';
            continue;
          }
        }
        if (runtime.dialogOpen(current.targetId)) return;
        if (secondary && event.action === 'down') await menu.observe(current).catch(() => {});
        await runtime.untilDialog(current.targetId, dispatchInput(current, event));
        if (secondary && event.action === 'up' && !runtime.dialogOpen(current.targetId)) await menu.settle(current, theme).catch(() => {});
      }
    },
    control(controller) {
      // The manager repeats the viewer's claim with every input batch; only a
      // change of hands closes the menu.
      if (runtime.controller !== controller) void runtime.contextMenu.close();
      runtime.controller = controller;
    },
    async resize(size) {
      const shown = await runtime.setPanelSize(size);
      this.refreshStream();
      return shown;
    },
    // The viewport or density changed: restart the screencast at the new
    // frame size. A long-poll waiting on the old stream gets the next frame.
    refreshStream() {
      const viewport = runtime.viewport;
      if (!page || !viewport) return;
      const wanted = `${viewport.width}x${viewport.height}@${deviceScale(viewport, viewport.scale)}`;
      if (wanted === streamedFor) return;
      detach();
      void start().catch(() => {});
    },
    async clipboard() {
      const current = await start();
      // A paused page runs no script, and its dialog is what has the focus.
      if (runtime.dialogOpen(current.targetId)) return '';
      const response = await current.cdp.sendSession(current.sessionId, 'Runtime.evaluate', {
        expression: clipboardExpression,
        returnByValue: true,
      });
      return typeof response.result?.value === 'string' ? response.result.value : '';
    },
    // The active tab changed: stop streaming the old one and wake long polls so
    // the next request starts on the new tab.
    retarget() {
      target += 1;
      detach();
      latest = null;
      for (const waiter of waiters) finishWaiter(waiter, null);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters) finishWaiter(waiter, null);
      await startPromise?.catch(() => {});
      detach();
    },
  };
};
