import React from 'react';
import type { FitAddon, Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';

import { cn } from '@/lib/utils';
import type { TerminalTheme } from '@/lib/terminalTheme';
import { getGhosttyTerminalOptions } from '@/lib/terminalTheme';
import {
  getGhosttySafeResetSequence,
  rewriteGhosttyDefaultBackgroundResets,
} from '@/lib/terminalOutput';
import {
  getTerminalCellFromPoint,
  getTerminalWordRange,
  type TerminalCellPosition,
} from '@/lib/terminalTouchSelection';
import type { TerminalChunk } from '@/stores/useTerminalStore';

// ghostty-web (638 KB raw of JS + the WASM VT) loads on demand: TerminalView
// stays eagerly importable for the bottom dock without pulling the emulator
// into the startup graph before a terminal is actually mounted.
type GhosttyModule = typeof import('ghostty-web');
type GhosttyRuntime = { module: GhosttyModule; ghostty: Ghostty };
let ghosttyRuntimePromise: Promise<GhosttyRuntime> | null = null;
const loadGhostty = (): Promise<GhosttyRuntime> =>
  ghosttyRuntimePromise ??= import('ghostty-web').then(async (module) => ({
    module,
    ghostty: await module.Ghostty.load(),
  }));

// The web entry defers its ~2 MB Nerd Font download until a terminal actually
// mounts (see the `__openchamberEnsureNerdFonts` hook in index.html). Wait for
// it with a short bound so a cached font is in place before the glyph atlas is
// built, while a cold CDN fetch never blocks the terminal from opening; the
// runtimes without the hook (VS Code, mobile) resolve immediately.
const NERD_FONT_WAIT_MS = 2000;
const ensureNerdFonts = (): Promise<void> => {
  if (typeof window === 'undefined') return Promise.resolve();
  const loader = (window as typeof window & { __openchamberEnsureNerdFonts?: () => Promise<void> }).__openchamberEnsureNerdFonts;
  if (typeof loader !== 'function') return Promise.resolve();
  return Promise.race([
    Promise.resolve(loader()).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, NERD_FONT_WAIT_MS)),
  ]).then(() => undefined);
};

type TerminalSize = { cols: number; rows: number };

const getProvisionalTerminalSize = (
  container: HTMLDivElement,
  fontFamily: string,
  fontSize: number,
): TerminalSize | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  const context = document.createElement('canvas').getContext('2d');
  if (!context || container.clientWidth < 24 || container.clientHeight < 24) return null;

  context.font = `${fontSize}px ${fontFamily}`;
  const metrics = context.measureText('M');
  const cellWidth = Math.ceil(metrics.width);
  const cellHeight = Math.ceil(
    (metrics.actualBoundingBoxAscent || fontSize * 0.8) +
    (metrics.actualBoundingBoxDescent || fontSize * 0.2),
  ) + 2;
  if (cellWidth < 1 || cellHeight < 1) return null;

  const style = window.getComputedStyle(container);
  const horizontalPadding =
    (Number.parseInt(style.paddingLeft, 10) || 0) +
    (Number.parseInt(style.paddingRight, 10) || 0);
  const verticalPadding =
    (Number.parseInt(style.paddingTop, 10) || 0) +
    (Number.parseInt(style.paddingBottom, 10) || 0);

  // Match Ghostty FitAddon's 15px scrollbar reservation and minimum dimensions.
  return {
    cols: Math.max(2, Math.floor((container.clientWidth - horizontalPadding - 15) / cellWidth)),
    rows: Math.max(1, Math.floor((container.clientHeight - verticalPadding) / cellHeight)),
  };
};

export type TerminalController = {
  focus: () => void;
  fit: () => void;
  getSelection: () => { text: string; startLine: number; endLine: number } | null;
};

type Props = {
  sessionKey: string;
  chunks: TerminalChunk[];
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  className?: string;
  enableTouchScroll?: boolean;
  autoFocus?: boolean;
  isVisible?: boolean;
};

const TerminalViewport = React.forwardRef<TerminalController, Props>(({
  sessionKey, chunks, onInput, onResize, theme, fontFamily, fontSize, className,
  enableTouchScroll = false, autoFocus = true, isVisible = true,
}, ref) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<GhosttyTerminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const inputRef = React.useRef(onInput);
  const resizeRef = React.useRef(onResize);
  const lastSizeRef = React.useRef<TerminalSize | null>(null);
  const provisionalSizeRef = React.useRef<TerminalSize | null>(null);
  const lastChunkRef = React.useRef<number | null>(null);
  const writeQueueRef = React.useRef('');
  const outputRewriteCarryRef = React.useRef('');
  const safeResetRef = React.useRef(getGhosttySafeResetSequence(theme.background));
  const writingRef = React.useRef(false);
  // Incremented whenever the replay stream restarts, so a write completing from
  // before the restart cannot clear the in-flight flag of a newer write.
  const writeEpochRef = React.useRef(0);
  const visibleRef = React.useRef(isVisible);
  const rendererReadyRef = React.useRef(false);
  const [ready, setReady] = React.useState(0);
  const [rendererGeneration, setRendererGeneration] = React.useState(0);
  inputRef.current = onInput;
  resizeRef.current = onResize;
  visibleRef.current = isVisible;
  safeResetRef.current = getGhosttySafeResetSequence(theme.background);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const size = getProvisionalTerminalSize(container, fontFamily, fontSize);
    provisionalSizeRef.current = size;
    if (size) resizeRef.current(size.cols, size.rows);
  }, [fontFamily, fontSize]);

  const fit = React.useCallback(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal || !fitRef.current || !visibleRef.current) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width < 24 || bounds.height < 24) return;
    try {
      fitRef.current.fit();
      const next = { cols: terminal.cols, rows: terminal.rows };
      if (!lastSizeRef.current || lastSizeRef.current.cols !== next.cols || lastSizeRef.current.rows !== next.rows) {
        lastSizeRef.current = next;
        resizeRef.current(next.cols, next.rows);
      }
      if (!rendererReadyRef.current) {
        rendererReadyRef.current = true;
        setReady((value) => value + 1);
      }
    } catch { /* hidden or detached */ }
  }, []);

  const flush = React.useCallback(() => {
    if (writingRef.current || !writeQueueRef.current || !terminalRef.current) return;
    const terminal = terminalRef.current;
    const pending = writeQueueRef.current;
    writeQueueRef.current = '';
    const rewritten = rewriteGhosttyDefaultBackgroundResets(
      pending,
      outputRewriteCarryRef.current,
      safeResetRef.current,
    );
    outputRewriteCarryRef.current = rewritten.carry;
    if (!rewritten.data) {
      if (writeQueueRef.current) flush();
      return;
    }
    writingRef.current = true;
    const epoch = writeEpochRef.current;
    terminal.write(rewritten.data, () => {
      if (terminalRef.current !== terminal || writeEpochRef.current !== epoch) return;
      writingRef.current = false;
      if (writeQueueRef.current) flush();
    });
  }, []);

  /**
   * Replay discontinuities (restart, reconnect, buffer reset) only need the VT
   * state cleared. `Terminal.reset()` frees and rebuilds the WASM terminal while
   * keeping the canvas, renderer and font atlas, so prefer it over remounting the
   * whole terminal; the generation bump remains the fallback before the terminal
   * exists.
   */
  const recreateRenderer = React.useCallback(() => {
    lastChunkRef.current = null;
    writeQueueRef.current = '';
    outputRewriteCarryRef.current = '';
    writingRef.current = false;
    writeEpochRef.current += 1;
    const terminal = terminalRef.current;
    if (!terminal) {
      setRendererGeneration((value) => value + 1);
      return;
    }
    try {
      terminal.reset();
      const safeReset = safeResetRef.current;
      if (safeReset) terminal.write(`${safeReset}\u001b[2J\u001b[H`);
    } catch {
      setRendererGeneration((value) => value + 1);
    }
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let terminal: GhosttyTerminal | null = null;
    let observer: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let fitFrame: number | null = null;
    let subscriptions: Array<{ dispose: () => void }> = [];
    const handleFocusIn = () => {
      if (terminal && visibleRef.current) terminal.options.cursorBlink = true;
    };
    const handleFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
      if (terminal) terminal.options.cursorBlink = false;
    };
    const handleWindowFocus = () => {
      if (terminal && visibleRef.current && container.contains(document.activeElement)) {
        terminal.options.cursorBlink = true;
      }
    };
    const handleWindowBlur = () => {
      if (terminal) terminal.options.cursorBlink = false;
    };

    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('focusout', handleFocusOut);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);

    Promise.all([loadGhostty(), ensureNerdFonts()]).then(([{ module, ghostty }]) => {
      if (disposed) return;
      terminal = new module.Terminal({
        ...getGhosttyTerminalOptions(fontFamily, fontSize, theme, ghostty, false),
        ...(provisionalSizeRef.current ?? {}),
      });
      const fitAddon = new module.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      // ghostty-web marks the container contenteditable for touch IME input but
      // sets autocapitalize/autocorrect only on its hidden textarea. Mobile
      // keyboards (iOS and Android) therefore auto-capitalize the first letter
      // of every terminal command; disable IME text mangling on the container.
      container.setAttribute('autocapitalize', 'off');
      container.setAttribute('autocorrect', 'off');
      container.setAttribute('spellcheck', 'false');
      terminalRef.current = terminal;
      fitRef.current = fitAddon;
      subscriptions = [terminal.onData((data) => inputRef.current(data))];
      observer = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(fit, 80);
      });
      observer.observe(container);
      fit();
      const safeReset = safeResetRef.current;
      if (safeReset) terminal.write(`${safeReset}\u001b[2J\u001b[H`);
      fitFrame = requestAnimationFrame(fit);
    });

    return () => {
      disposed = true;
      // Removing a focused editable mid-IME-composition wedges Android
      // WebView's input dispatch (the whole app stops responding to touch).
      // Blur first so the IME detaches cleanly, and hide the soft keyboard
      // explicitly on Android before the terminal DOM is torn down.
      const active = document.activeElement;
      if (active instanceof HTMLElement && container.contains(active)) {
        active.blur();
        const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
        if (capacitor?.getPlatform?.() === 'android') {
          void import('@capacitor/keyboard')
            .then(({ Keyboard }) => Keyboard.hide())
            .catch(() => undefined);
        }
      }
      observer?.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
      subscriptions.forEach((subscription) => subscription.dispose());
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      lastSizeRef.current = null;
      lastChunkRef.current = null;
      writeQueueRef.current = '';
      outputRewriteCarryRef.current = '';
      writingRef.current = false;
      writeEpochRef.current += 1;
      rendererReadyRef.current = false;
    };
  }, [fit, fontFamily, fontSize, rendererGeneration, theme]);

  React.useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    terminal.options.cursorBlink = isVisible && document.hasFocus() && container.contains(document.activeElement);
  }, [isVisible, ready]);

  React.useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (chunks.length === 0) {
      if (lastChunkRef.current !== null) recreateRenderer();
      return;
    }
    const previous = lastChunkRef.current;
    // Chunk ids are monotonic and the store appends, so the already-written chunk
    // is normally the last one. Scanning from the end keeps this O(1) per chunk
    // instead of O(chunks) on every streamed write.
    let previousIndex = -1;
    if (previous !== null) {
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const id = chunks[index].id;
        if (id === previous) { previousIndex = index; break; }
        if (id < previous) break;
      }
      if (previousIndex < 0) {
        recreateRenderer();
        return;
      }
    }
    const isReplay = previousIndex < 0;
    const pending = previousIndex >= 0 ? chunks.slice(previousIndex + 1) : chunks;
    writeQueueRef.current += pending.map((chunk) => isReplay ? (chunk.replayData ?? chunk.data) : chunk.data).join('');
    lastChunkRef.current = chunks.at(-1)?.id ?? null;
    flush();
  }, [chunks, flush, ready, recreateRenderer]);

  React.useEffect(() => {
    if (!autoFocus || !isVisible) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, isVisible, ready, sessionKey]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!enableTouchScroll || !container) return;
    // ghostty-web only reads keydown/composition events and preventDefaults
    // beforeinput without consuming it. Android IMEs deliver text via
    // beforeinput (their keydown arrives as keyCode 229, which ghostty
    // ignores), so forward those payloads to the terminal here. Composition
    // updates are skipped: ghostty commits them itself on compositionend.
    const handleBeforeInput = (event: Event) => {
      const input = event as InputEvent;
      if (input.isComposing) return;
      switch (input.inputType) {
        case 'insertText':
          if (input.data) inputRef.current(input.data);
          break;
        case 'insertLineBreak':
        case 'insertParagraph':
          inputRef.current('\r');
          break;
        case 'deleteContentBackward':
          inputRef.current('\x7f');
          break;
        default:
          break;
      }
    };
    container.addEventListener('beforeinput', handleBeforeInput);
    return () => container.removeEventListener('beforeinput', handleBeforeInput);
  }, [enableTouchScroll, ready]);

  React.useEffect(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!enableTouchScroll || !container || !terminal) return;
    let pointerId: number | null = null;
    let longPressTimeout: ReturnType<typeof setTimeout> | null = null;
    let gesture: 'idle' | 'pending' | 'scrolling' | 'selecting' = 'idle';
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let remainder = 0;
    let selectionFocus: TerminalCellPosition | null = null;
    const lineHeight = Math.max(12, fontSize + 2);
    // Android WebView only raises the soft keyboard for a native tap-focus; the
    // pointer-captured, touch-action:none tap here focuses programmatically, so
    // the IME must be summoned explicitly via the Capacitor Keyboard plugin.
    const showAndroidSoftKeyboard = () => {
      const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
      if (capacitor?.getPlatform?.() !== 'android') return;
      void import('@capacitor/keyboard')
        .then(({ Keyboard }) => Keyboard.show())
        .catch(() => undefined);
    };
    const clearLongPress = () => {
      if (!longPressTimeout) return;
      clearTimeout(longPressTimeout);
      longPressTimeout = null;
    };
    const cellFromPoint = (clientX: number, clientY: number) => {
      const canvas = container.querySelector('canvas');
      if (!canvas) return null;
      return getTerminalCellFromPoint(clientX, clientY, canvas.getBoundingClientRect(), terminal.cols, terminal.rows);
    };
    const dispatchSelectionMouseEvent = (
      type: 'mousedown' | 'mousemove',
      cell: TerminalCellPosition,
    ) => {
      const canvas = container.querySelector('canvas');
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const clientX = bounds.left + ((cell.column + 0.5) / terminal.cols) * bounds.width;
      const clientY = bounds.top + ((cell.row + 0.5) / terminal.rows) * bounds.height;
      canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
      }));
    };
    const finishSelection = () => {
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
      }));
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || pointerId !== null) return;
      pointerId = event.pointerId;
      gesture = 'pending';
      startX = event.clientX;
      startY = event.clientY;
      lastY = event.clientY;
      remainder = 0;
      selectionFocus = null;
      container.setPointerCapture(event.pointerId);
      longPressTimeout = setTimeout(() => {
        longPressTimeout = null;
        if (pointerId !== event.pointerId || gesture !== 'pending') return;
        const cell = cellFromPoint(startX, startY);
        if (!cell) return;

        const buffer = terminal.buffer.active;
        const lineIndex = Math.max(0, buffer.length - terminal.rows - buffer.viewportY + cell.row);
        const line = buffer.getLine(lineIndex);
        const cells = Array.from({ length: terminal.cols }, (_, column) => line?.getCell(column)?.getChars() ?? '');
        const word = getTerminalWordRange(cells, cell.column);
        const selectionAnchor = { column: word.startColumn, row: cell.row };
        selectionFocus = { column: word.endColumn, row: cell.row };
        gesture = 'selecting';
        dispatchSelectionMouseEvent('mousedown', selectionAnchor);
        dispatchSelectionMouseEvent('mousemove', selectionFocus);
      }, 350);
    };
    const move = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;

      if (gesture === 'selecting') {
        const focus = cellFromPoint(event.clientX, event.clientY);
        if (focus && (!selectionFocus || focus.column !== selectionFocus.column || focus.row !== selectionFocus.row)) {
          selectionFocus = focus;
          dispatchSelectionMouseEvent('mousemove', focus);
        }
        if (event.cancelable) event.preventDefault();
        return;
      }

      if (gesture === 'pending') {
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (distance < 8) return;
        clearLongPress();
        gesture = 'scrolling';
      }

      if (gesture !== 'scrolling') return;
      const delta = lastY - event.clientY;
      lastY = event.clientY;
      remainder += delta;
      const lines = Math.trunc(remainder / lineHeight);
      if (lines) { terminal.scrollLines(lines); remainder -= lines * lineHeight; }
      if (event.cancelable) event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const shouldFocus = gesture === 'pending';
      const shouldFinishSelection = gesture === 'selecting';
      clearLongPress();
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      pointerId = null;
      gesture = 'idle';
      if (shouldFinishSelection) finishSelection();
      if (shouldFocus) {
        terminal.focus();
        showAndroidSoftKeyboard();
      }
    };
    const cancel = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const shouldFinishSelection = gesture === 'selecting';
      clearLongPress();
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      pointerId = null;
      gesture = 'idle';
      if (shouldFinishSelection) finishSelection();
    };
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move, { passive: false });
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', cancel);
    return () => {
      clearLongPress();
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('pointercancel', cancel);
    };
  }, [enableTouchScroll, fontSize, ready]);

  React.useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus(),
    fit,
    getSelection: () => {
      const terminal = terminalRef.current;
      const range = terminal?.getSelectionPosition();
      const text = terminal?.getSelection() ?? '';
      if (!range || !text.trim()) return null;
      return { text, startLine: range.start.y + 1, endLine: range.end.y + 1 };
    },
  }), [fit]);

  return (
    <div
      ref={containerRef}
      data-terminal-owner="main"
      className={cn('terminal-viewport-container h-full w-full overflow-hidden touch-none', className)}
    />
  );
});

TerminalViewport.displayName = 'TerminalViewport';
export { TerminalViewport };
