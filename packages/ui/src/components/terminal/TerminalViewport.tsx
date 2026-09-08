import React from 'react';

import { cn } from '@/lib/utils';
import { loadMonoFont } from '@/lib/fontLoader';
import type { MonoFontOption } from '@/lib/fontOptions';
import type { TerminalTheme } from '@/lib/terminalTheme';
import { toGhosttyTheme } from '@/lib/terminalTheme';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import type { TerminalChunk } from '@/stores/useTerminalStore';

import { selectTerminalChunkReplay } from './terminalChunkReplay';

// The libghostty-vt adapter (WASM VT + canvas renderer) loads on demand so the
// bottom dock can import TerminalView eagerly without pulling the emulator
// into the startup graph before a terminal is actually mounted.
type GhosttyTerminalSurface = import('@/lib/ghostty/surface').GhosttyTerminalSurface;
type GhosttyTerminalSurfaceOptions = import('@/lib/ghostty/surface').GhosttyTerminalSurfaceOptions;

/** The subset of the surface the viewport drives; tests inject a double. */
export type TerminalSurface = Pick<
  GhosttyTerminalSurface,
  | 'write'
  | 'resetAndWrite'
  | 'setTheme'
  | 'setFont'
  | 'setVisible'
  | 'fit'
  | 'refresh'
  | 'focus'
  | 'getSelection'
  | 'getSelectionPosition'
  | 'scrollLines'
  | 'selectWordAt'
  | 'extendSelectionTo'
  | 'dispose'
>;

export type TerminalSurfaceFactory = (
  mount: HTMLElement,
  options: GhosttyTerminalSurfaceOptions,
) => Promise<TerminalSurface>;

const createGhosttySurface: TerminalSurfaceFactory = async (mount, options) => {
  const { GhosttyTerminalSurface } = await import('@/lib/ghostty/surface');
  return GhosttyTerminalSurface.create(mount, options);
};

// The selected mono face loads from the app bundle, so this normally resolves
// at once. A stalled fetch must not keep the terminal from opening: after the
// bound the surface measures with whatever faces are available and refits
// when the face arrives (document.fonts "loadingdone").
const TERMINAL_FONT_WAIT_MS = 2000;
const waitForMonoFont = (font: MonoFontOption): Promise<void> =>
  new Promise((resolve) => {
    const timeout = setTimeout(resolve, TERMINAL_FONT_WAIT_MS);
    void loadMonoFont(font).finally(() => {
      clearTimeout(timeout);
      resolve();
    });
  });

type TerminalSize = { cols: number; rows: number };

const CONTENT_PADDING = 4;

const getProvisionalTerminalSize = (
  container: HTMLDivElement,
  fontFamily: string,
  fontSize: number,
): TerminalSize | null => {
  const context = container.ownerDocument.createElement('canvas').getContext('2d');
  if (!context || container.clientWidth < 24 || container.clientHeight < 24) return null;

  context.font = `${fontSize}px ${fontFamily}`;
  const metrics = context.measureText('M');
  const cellWidth = metrics.width;
  const glyphHeight = (metrics.actualBoundingBoxAscent || fontSize * 0.8) + (metrics.actualBoundingBoxDescent || fontSize * 0.2);
  // Mirrors measureGhosttyCell: the line height is the larger of 1.35em and the glyph box.
  const cellHeight = Math.max(1, Math.round(fontSize * 1.35), Math.ceil(glyphHeight));
  if (cellWidth < 1 || cellHeight < 1) return null;

  return {
    cols: Math.max(2, Math.floor((container.clientWidth - CONTENT_PADDING * 2) / cellWidth)),
    rows: Math.max(1, Math.floor((container.clientHeight - CONTENT_PADDING * 2) / cellHeight)),
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
  /** Fitted size: the emulator has this size, so the PTY should follow. */
  onResize: (cols: number, rows: number) => void;
  /**
   * Size estimated from the container before Ghostty has measured anything.
   * Good enough to spawn a shell early, not authoritative: an existing PTY
   * must not be resized to it. Falls back to `onResize` when omitted.
   */
  onProvisionalSize?: (cols: number, rows: number) => void;
  theme: TerminalTheme;
  monoFont: MonoFontOption;
  fontFamily: string;
  fontSize: number;
  className?: string;
  enableTouchScroll?: boolean;
  autoFocus?: boolean;
  isVisible?: boolean;
  /** Surface construction, injectable for tests. */
  createSurface?: TerminalSurfaceFactory;
};

const TerminalViewport = React.forwardRef<TerminalController, Props>(({
  sessionKey, chunks, onInput, onResize, onProvisionalSize, theme, monoFont, fontFamily, fontSize, className,
  enableTouchScroll = false, autoFocus = true, isVisible = true, createSurface = createGhosttySurface,
}, ref) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const surfaceRef = React.useRef<TerminalSurface | null>(null);
  const inputRef = React.useRef(onInput);
  const resizeRef = React.useRef(onResize);
  const provisionalSizeCallbackRef = React.useRef(onProvisionalSize);
  const lastChunkRef = React.useRef<number | null>(null);
  const visibleRef = React.useRef(isVisible);
  const labelsRef = React.useRef({ input: '', scrollbar: '' });
  const [ready, setReady] = React.useState(0);
  inputRef.current = onInput;
  resizeRef.current = onResize;
  provisionalSizeCallbackRef.current = onProvisionalSize;
  visibleRef.current = isVisible;
  labelsRef.current = {
    input: t('terminalView.viewport.inputAria'),
    scrollbar: t('terminalView.viewport.scrollbarAria'),
  };

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const size = getProvisionalTerminalSize(container, fontFamily, fontSize);
    if (size) (provisionalSizeCallbackRef.current ?? resizeRef.current)(size.cols, size.rows);
  }, [fontFamily, fontSize]);

  // The surface lives for the whole mount. Theme and font changes are applied
  // in place below; only the container identity and the factory can recreate it.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let surface: TerminalSurface | null = null;
    const initialTheme = theme;
    const initialFont = { family: fontFamily, size: fontSize };
    const initialMonoFont = monoFont;
    const ownsTouch = !enableTouchScroll;

    void (async () => {
      await waitForMonoFont(initialMonoFont);
      if (disposed) return;
      let created: TerminalSurface;
      try {
        created = await createSurface(container, {
          theme: toGhosttyTheme(initialTheme),
          font: initialFont,
          get visible() {
            return visibleRef.current;
          },
          labels: labelsRef.current,
          handleTouchPointer: ownsTouch,
          onData: (data) => inputRef.current(data),
          onResize: (cols, rows) => resizeRef.current(cols, rows),
          onLinkActivate: (text) => {
            void openExternalUrl(text);
          },
        });
      } catch (error) {
        console.error('[terminal] failed to initialize the terminal renderer', error);
        return;
      }
      if (disposed) {
        created.dispose();
        return;
      }
      surface = created;
      surfaceRef.current = created;
      created.setVisible(visibleRef.current);
      setReady((value) => value + 1);
    })();

    return () => {
      disposed = true;
      // Removing a focused editable mid-IME-composition wedges Android
      // WebView's input dispatch (the whole app stops responding to touch).
      // Blur first so the IME detaches cleanly, and hide the soft keyboard
      // explicitly on Android before the terminal DOM is torn down.
      const active = document.activeElement;
      if (active instanceof HTMLElement && container.contains(active)) {
        active.blur();
        // SAFETY: the Capacitor bridge installs window.Capacitor with getPlatform() on native shells only.
        const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
        if (capacitor?.getPlatform?.() === 'android') {
          void import('@capacitor/keyboard')
            .then(({ Keyboard }) => Keyboard.hide())
            .catch(() => undefined);
        }
      }
      surface?.dispose();
      surface = null;
      surfaceRef.current = null;
      lastChunkRef.current = null;
    };
    // Theme, font and touch mode are applied to the live surface by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSurface]);

  React.useEffect(() => {
    surfaceRef.current?.setTheme(toGhosttyTheme(theme));
  }, [theme, ready]);

  React.useEffect(() => {
    void surfaceRef.current?.setFont({ family: fontFamily, size: fontSize });
  }, [fontFamily, fontSize, ready]);

  React.useEffect(() => {
    surfaceRef.current?.setVisible(isVisible);
  }, [isVisible, ready]);

  React.useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const { reset, replay, pending } = selectTerminalChunkReplay(chunks, lastChunkRef.current);
    if (replay) {
      // Snapshot history is laid out for the PTY size recorded on its chunk;
      // the surface replays it at that size and reflows to the fitted grid.
      const [snapshot, ...live] = pending;
      surface.resetAndWrite(snapshot ? (snapshot.replayData ?? snapshot.data) : '', snapshot?.size);
      const liveData = live.map((chunk) => chunk.replayData ?? chunk.data).join('');
      if (liveData) surface.write(liveData);
    } else if (reset) {
      surface.resetAndWrite('');
    } else if (pending.length > 0) {
      surface.write(pending.map((chunk) => chunk.data).join(''));
    }
    lastChunkRef.current = chunks.at(-1)?.id ?? null;
  }, [chunks, ready]);

  React.useEffect(() => {
    if (!autoFocus || !isVisible) return;
    const frame = requestAnimationFrame(() => surfaceRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, isVisible, ready, sessionKey]);

  React.useEffect(() => {
    const container = containerRef.current;
    const surface = surfaceRef.current;
    if (!enableTouchScroll || !container || !surface) return;
    let pointerId: number | null = null;
    let longPressTimeout: ReturnType<typeof setTimeout> | null = null;
    let gesture: 'idle' | 'pending' | 'scrolling' | 'selecting' = 'idle';
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let remainder = 0;
    const lineHeight = Math.max(12, Math.round(fontSize * 1.35));
    // Android WebView only raises the soft keyboard for a native tap-focus; the
    // pointer-captured, touch-action:none tap here focuses programmatically, so
    // the IME must be summoned explicitly via the Capacitor Keyboard plugin.
    const showAndroidSoftKeyboard = () => {
      // SAFETY: the Capacitor bridge installs window.Capacitor with getPlatform() on native shells only.
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
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || pointerId !== null) return;
      pointerId = event.pointerId;
      gesture = 'pending';
      startX = event.clientX;
      startY = event.clientY;
      lastY = event.clientY;
      remainder = 0;
      container.setPointerCapture(event.pointerId);
      longPressTimeout = setTimeout(() => {
        longPressTimeout = null;
        if (pointerId !== event.pointerId || gesture !== 'pending') return;
        if (surface.selectWordAt(startX, startY)) gesture = 'selecting';
      }, 350);
    };
    const move = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;

      if (gesture === 'selecting') {
        surface.extendSelectionTo(event.clientX, event.clientY);
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
      if (lines) { surface.scrollLines(lines); remainder -= lines * lineHeight; }
      if (event.cancelable) event.preventDefault();
    };
    const finish = (event: PointerEvent, focusOnTap: boolean) => {
      if (pointerId !== event.pointerId) return;
      const shouldFocus = focusOnTap && gesture === 'pending';
      clearLongPress();
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      pointerId = null;
      gesture = 'idle';
      if (shouldFocus) {
        surface.focus();
        showAndroidSoftKeyboard();
      }
    };
    const up = (event: PointerEvent) => finish(event, true);
    const cancel = (event: PointerEvent) => finish(event, false);
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
    focus: () => surfaceRef.current?.focus(),
    fit: () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      surface.fit();
      surface.refresh();
    },
    getSelection: () => {
      const surface = surfaceRef.current;
      const range = surface?.getSelectionPosition();
      const text = surface?.getSelection() ?? '';
      if (!range || !text.trim()) return null;
      return { text, startLine: range.start.y + 1, endLine: range.end.y + 1 };
    },
  }), []);

  return (
    <div
      ref={containerRef}
      data-terminal-owner="main"
      className={cn('terminal-viewport-container relative h-full w-full overflow-hidden touch-none', className)}
    />
  );
});

TerminalViewport.displayName = 'TerminalViewport';
export { TerminalViewport };
