import React from 'react';
import { FitAddon, Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';

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

let ghosttyPromise: Promise<Ghostty> | null = null;
const loadGhostty = (): Promise<Ghostty> => ghosttyPromise ??= Ghostty.load();

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
  const lastSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
  const lastChunkRef = React.useRef<number | null>(null);
  const writeQueueRef = React.useRef('');
  const outputRewriteCarryRef = React.useRef('');
  const safeResetRef = React.useRef(getGhosttySafeResetSequence(theme.background));
  const writingRef = React.useRef(false);
  const visibleRef = React.useRef(isVisible);
  const rendererReadyRef = React.useRef(false);
  const [ready, setReady] = React.useState(0);
  const [rendererGeneration, setRendererGeneration] = React.useState(0);
  inputRef.current = onInput;
  resizeRef.current = onResize;
  visibleRef.current = isVisible;
  safeResetRef.current = getGhosttySafeResetSequence(theme.background);

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
    terminal.write(rewritten.data, () => {
      if (terminalRef.current !== terminal) return;
      writingRef.current = false;
      if (writeQueueRef.current) flush();
    });
  }, []);

  const recreateRenderer = React.useCallback(() => {
    lastChunkRef.current = null;
    writeQueueRef.current = '';
    outputRewriteCarryRef.current = '';
    writingRef.current = false;
    setRendererGeneration((value) => value + 1);
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

    loadGhostty().then((ghostty) => {
      if (disposed) return;
      terminal = new GhosttyTerminal(getGhosttyTerminalOptions(fontFamily, fontSize, theme, ghostty, false));
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
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
    const previousIndex = previous === null ? -1 : chunks.findIndex((chunk) => chunk.id === previous);
    if (previous !== null && previousIndex < 0) {
      recreateRenderer();
      return;
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
      if (shouldFocus) terminal.focus();
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
