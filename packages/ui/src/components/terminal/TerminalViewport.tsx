import React from 'react';
import { createPortal } from 'react-dom';
import { Ghostty, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';

import { isMobileDeviceViaCSS } from '@/lib/device';
import type { TerminalTheme } from '@/lib/terminalTheme';
import { getGhosttyTerminalOptions } from '@/lib/terminalTheme';
import type { TerminalChunk } from '@/stores/useTerminalStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';

let ghosttyPromise: Promise<Ghostty> | null = null;

function getGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = Ghostty.load();
  }
  return ghosttyPromise;
}

function findScrollableViewport(container: HTMLElement): HTMLElement | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const candidates = [container, ...Array.from(container.querySelectorAll<HTMLElement>('*'))];
  let fallback: HTMLElement | null = null;

  for (const element of candidates) {
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') {
      continue;
    }

    // Prefer an element that is currently scrollable.
    if (element.scrollHeight - element.clientHeight > 2) {
      return element;
    }

    // Otherwise keep the first overflow container as a fallback so we can
    // attach touch scroll before scrollback grows.
    if (!fallback) {
      fallback = element;
    }
  }

  return fallback;
}

type TerminalController = {
  focus: () => void;
  clear: () => void;
  fit: () => void;
};

type TerminalWithViewport = {
  scrollToBottom?: () => void;
  getViewportY?: () => number;
  hasSelection?: () => boolean;
};

type FitAddonWithObserveResize = FitAddon & {
  observeResize?: () => void;
};

interface TerminalViewportProps {
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
  keyboardAvoidTargetId?: string;
}

const TerminalViewport = React.forwardRef<TerminalController, TerminalViewportProps>(
  (
    {
      sessionKey,
      chunks,
      onInput,
      onResize,
      theme,
      fontFamily,
      fontSize,
      className,
      enableTouchScroll,
      autoFocus = true,
      keyboardAvoidTargetId,
    },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const viewportRef = React.useRef<HTMLElement | null>(null);
    const terminalRef = React.useRef<GhosttyTerminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const inputHandlerRef = React.useRef<(data: string) => void>(onInput);
    const resizeHandlerRef = React.useRef<(cols: number, rows: number) => void>(onResize);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const pendingWriteRef = React.useRef('');
    const writeScheduledRef = React.useRef<number | null>(null);
    const isWritingRef = React.useRef(false);
    const lastProcessedChunkIdRef = React.useRef<number | null>(null);
    const followOutputRef = React.useRef(true);
    const touchScrollCleanupRef = React.useRef<(() => void) | null>(null);
    const viewportDiscoveryTimeoutRef = React.useRef<number | null>(null);
    const viewportDiscoveryAttemptsRef = React.useRef(0);
    const hiddenInputRef = React.useRef<HTMLTextAreaElement | null>(null);
    const textInputRef = React.useRef<HTMLInputElement | null>(null);
    const isComposingRef = React.useRef(false);
    const ignoreNextInputRef = React.useRef(false);
    const lastBeforeInputRef = React.useRef<{ type: string; at: number } | null>(null);
    const lastInputEventAtRef = React.useRef<number | null>(null);
    const refocusTimeoutRef = React.useRef<number | null>(null);
    const keydownProbeTimeoutRef = React.useRef<number | null>(null);
    const lastObservedValueRef = React.useRef('');
    const cursorBlinkStateRef = React.useRef<boolean | null>(null);
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    const [terminalReadyVersion, bumpTerminalReady] = React.useReducer((x) => x + 1, 0);

    inputHandlerRef.current = onInput;
    resizeHandlerRef.current = onResize;

    const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    const prefersTouchOnlyPointer = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches
      && window.matchMedia('(hover: none)').matches;
    const useHiddenInputOverlay = Boolean(enableTouchScroll)
      && (isAndroid || isMobileDeviceViaCSS() || prefersTouchOnlyPointer);

    const disableTerminalTextareas = React.useCallback(() => {
      const container = containerRef.current;
      const hiddenInput = hiddenInputRef.current;
      if (!container) {
        return;
      }

      const editableNodes = Array.from(container.querySelectorAll<HTMLElement>('[contenteditable="true"]'));
      editableNodes.forEach((node) => {
        node.style.setProperty('caret-color', 'transparent');
        node.style.outline = 'none';
      });

      const textareas = Array.from(container.querySelectorAll('textarea')) as HTMLTextAreaElement[];
      textareas.forEach((textarea) => {
        textarea.style.setProperty('caret-color', 'transparent');
        textarea.style.color = 'transparent';
        textarea.style.setProperty('-webkit-text-fill-color', 'transparent');
        textarea.style.background = 'transparent';
        textarea.style.border = '0';
        textarea.style.outline = 'none';
        textarea.style.boxShadow = 'none';
        textarea.style.textShadow = 'none';
        textarea.style.fontSize = '0';
        textarea.style.lineHeight = '0';

        if (!useHiddenInputOverlay) {
          return;
        }

        if (textarea === hiddenInput) {
          return;
        }
        if (textarea.getAttribute('data-terminal-disabled-input') === 'true') {
          return;
        }
        textarea.setAttribute('data-terminal-disabled-input', 'true');
        textarea.setAttribute('aria-hidden', 'true');
        textarea.tabIndex = -1;
        textarea.disabled = true;
        textarea.style.position = 'absolute';
        textarea.style.opacity = '0';
        textarea.style.width = '0px';
        textarea.style.height = '0px';
        textarea.style.pointerEvents = 'none';
        textarea.style.zIndex = '-1';
      });
    }, [useHiddenInputOverlay]);

    const setTerminalCursorBlink = React.useCallback((enabled: boolean) => {
      if (cursorBlinkStateRef.current === enabled) {
        return;
      }

      const terminal = terminalRef.current as unknown as {
        setOption?: (key: string, value: unknown) => void;
        options?: { cursorBlink?: boolean };
      } | null;

      if (!terminal) {
        return;
      }

      try {
        if (typeof terminal.setOption === 'function') {
          terminal.setOption('cursorBlink', enabled);
          cursorBlinkStateRef.current = enabled;
          return;
        }

        if (terminal.options) {
          terminal.options.cursorBlink = enabled;
          cursorBlinkStateRef.current = enabled;
        }
      } catch {
        // ignored
      }
    }, []);

    const useTextInput = useHiddenInputOverlay && isAndroid;

    const focusHiddenInput = React.useCallback((clientX?: number, clientY?: number) => {
      const input = (useTextInput ? textInputRef.current : hiddenInputRef.current) as HTMLElement | null;
      const container = containerRef.current;
      if (!input || !container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : rect.width;
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : rect.height;
      const fallbackX = rect.left + rect.width / 2;
      const fallbackY = rect.top + rect.height - 12;
      const x = typeof clientX === 'number' ? clientX : fallbackX;
      const y = typeof clientY === 'number' ? clientY : fallbackY;

      const padding = 8;
      const left = Math.max(padding, Math.min(viewportWidth - padding, x));
      const top = Math.max(padding, Math.min(viewportHeight - padding, y));

      input.style.left = `${left}px`;
      input.style.top = `${top}px`;
      input.style.bottom = '';

      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        input.disabled = false;
        input.readOnly = false;
        input.removeAttribute('disabled');
        input.removeAttribute('readonly');
      }

      try {
        input.focus({ preventScroll: true });
      } catch {
        try {
          input.focus();
        } catch { /* ignored */ }
      }
    }, [useTextInput]);

    const focusTerminalInput = React.useCallback(() => {
      if (useHiddenInputOverlay) {
        focusHiddenInput();
        setTerminalCursorBlink(true);
        return;
      }
      terminalRef.current?.focus();
      setTerminalCursorBlink(true);
    }, [focusHiddenInput, setTerminalCursorBlink, useHiddenInputOverlay]);

    const readEditableValue = React.useCallback((target: HTMLElement) => {
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return target.value;
      }
      return target.textContent ?? '';
    }, []);

    const clearEditableValue = React.useCallback((target: HTMLElement) => {
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        target.value = '';
        return;
      }
      target.textContent = '';
    }, []);

    const scheduleKeyProbe = React.useCallback((target: HTMLElement) => {
      if (typeof window === 'undefined') {
        return;
      }
      if (useTextInput) {
        return;
      }

      if (keydownProbeTimeoutRef.current !== null) {
        window.clearTimeout(keydownProbeTimeoutRef.current);
        keydownProbeTimeoutRef.current = null;
      }

      let attempt = 0;
      const maxAttempts = 3;

      const runProbe = () => {
        keydownProbeTimeoutRef.current = window.setTimeout(() => {
          keydownProbeTimeoutRef.current = null;
          const value = readEditableValue(target);
          if (!value) {
            attempt += 1;
            if (attempt < maxAttempts) {
              runProbe();
              return;
            }
            return;
          }
          const previous = lastObservedValueRef.current;
          lastObservedValueRef.current = value;
          const delta = value.startsWith(previous) ? value.slice(previous.length) : value;
          if (delta) {
            inputHandlerRef.current(delta.replace(/\r\n|\r|\n/g, '\r'));
          }
          clearEditableValue(target);
          lastObservedValueRef.current = '';
        }, attempt === 0 ? 0 : 24);
      };

      runProbe();
    }, [clearEditableValue, readEditableValue, useTextInput]);

    React.useEffect(() => {
      const container = containerRef.current;
      if (!useHiddenInputOverlay || !container || enableTouchScroll) {
        return;
      }

      const handleContainerFocusIn = (event: FocusEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
          return;
        }
        if (target.getAttribute('data-terminal-hidden-input') === 'true') {
          return;
        }
        if (!container.contains(target)) {
          return;
        }
        try {
          target.blur();
        } catch { /* ignored */ }
        focusHiddenInput();
      };

      container.addEventListener('focusin', handleContainerFocusIn, true);
      return () => {
        container.removeEventListener('focusin', handleContainerFocusIn, true);
      };
    }, [enableTouchScroll, useHiddenInputOverlay, focusHiddenInput]);

    const getTerminalSelectionText = React.useCallback((): string => {
      const terminal = terminalRef.current as unknown as {
        getSelection?: () => string;
      } | null;
      if (!terminal || typeof terminal.getSelection !== 'function') {
        return '';
      }
      const text = terminal.getSelection();
      return typeof text === 'string' ? text : '';
    }, []);

    const getDomSelectionTextInViewport = React.useCallback((): string => {
      if (typeof window === 'undefined') {
        return '';
      }
      const selection = window.getSelection();
      if (!selection) {
        return '';
      }

      const text = selection.toString();
      if (!text.trim()) {
        return '';
      }

      const container = containerRef.current;
      if (!container) {
        return '';
      }

      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (anchorNode && !container.contains(anchorNode)) {
        return '';
      }
      if (focusNode && !container.contains(focusNode)) {
        return '';
      }

      return text;
    }, []);

    const copySelectionToClipboard = React.useCallback(async () => {
      if (typeof document === 'undefined') {
        return;
      }

      const text = getTerminalSelectionText() || getDomSelectionTextInViewport();
      if (!text.trim()) {
        return;
      }

      await copyTextToClipboard(text);
    }, [getDomSelectionTextInViewport, getTerminalSelectionText]);

    const hasCopyableSelectionInViewport = React.useCallback((): boolean => {
      const terminalSelection = getTerminalSelectionText();
      if (terminalSelection.trim()) {
        return true;
      }
      return Boolean(getDomSelectionTextInViewport().trim());
    }, [getDomSelectionTextInViewport, getTerminalSelectionText]);

    React.useEffect(() => {
      if (typeof window === 'undefined') {
        return;
      }

      const handleMenuCopy = (event: Event) => {
        if (!hasCopyableSelectionInViewport()) {
          return;
        }
        event.preventDefault();
        void copySelectionToClipboard();
      };

      window.addEventListener('openchamber:copy', handleMenuCopy);
      return () => {
        window.removeEventListener('openchamber:copy', handleMenuCopy);
      };
    }, [copySelectionToClipboard, hasCopyableSelectionInViewport]);

    const resetWriteState = React.useCallback(() => {
      pendingWriteRef.current = '';
      if (writeScheduledRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(writeScheduledRef.current);
      }
      writeScheduledRef.current = null;
      isWritingRef.current = false;
      lastProcessedChunkIdRef.current = null;
    }, []);

    const fitTerminal = React.useCallback(() => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!fitAddon || !terminal || !container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        return;
      }
      try {
        fitAddon.fit();
        const next = { cols: terminal.cols, rows: terminal.rows };
        const previous = lastReportedSizeRef.current;
        if (!previous || previous.cols !== next.cols || previous.rows !== next.rows) {
          lastReportedSizeRef.current = next;
          resizeHandlerRef.current(next.cols, next.rows);
        }
      } catch { /* ignored */ }
    }, []);

    const flushWrites = React.useCallback(() => {
      if (isWritingRef.current) {
        return;
      }

      const term = terminalRef.current;
      if (!term) {
        resetWriteState();
        return;
      }

      if (!pendingWriteRef.current) {
        return;
      }

      const chunk = pendingWriteRef.current;
      pendingWriteRef.current = '';

      isWritingRef.current = true;
      term.write(chunk, () => {
        isWritingRef.current = false;
        if (pendingWriteRef.current) {
          if (typeof window !== 'undefined') {
            writeScheduledRef.current = window.requestAnimationFrame(() => {
              writeScheduledRef.current = null;
              flushWrites();
            });
          } else {
            flushWrites();
          }
        }
      });
    }, [resetWriteState]);

    const scheduleFlushWrites = React.useCallback(() => {
      if (writeScheduledRef.current !== null) {
        return;
      }
      if (typeof window !== 'undefined') {
        writeScheduledRef.current = window.requestAnimationFrame(() => {
          writeScheduledRef.current = null;
          flushWrites();
        });
      } else {
        flushWrites();
      }
    }, [flushWrites]);

    const enqueueWrite = React.useCallback(
      (data: string) => {
        if (!data) {
          return;
        }
        pendingWriteRef.current += data;
        scheduleFlushWrites();
      },
      [scheduleFlushWrites]
    );

    const setupTouchScroll = React.useCallback(() => {
      touchScrollCleanupRef.current?.();
      touchScrollCleanupRef.current = null;

      if (viewportDiscoveryTimeoutRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(viewportDiscoveryTimeoutRef.current);
        viewportDiscoveryTimeoutRef.current = null;
      }

      if (!enableTouchScroll) {
        viewportDiscoveryAttemptsRef.current = 0;
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      // Ghostty scrollback is internal (canvas-based). On touch devices we need
      // to translate touch deltas into terminal scroll calls.
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      viewportDiscoveryAttemptsRef.current = 0;

      const baseScrollMultiplier = 2.2;
      const maxScrollBoost = 2.8;
      const boostDenominator = 25;
      const velocityAlpha = 0.25;
      const maxVelocity = 8;
      const minVelocity = 0.05;
      const deceleration = 0.015;

      const state = {
        lastY: null as number | null,
        lastTime: null as number | null,
        velocity: 0,
        rafId: null as number | null,
        startX: null as number | null,
        startY: null as number | null,
        didMove: false,
      };

      const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      let remainderPx = 0;

      const scrollByPixels = (deltaPixels: number) => {
        if (!deltaPixels) {
          return false;
        }

        const before = terminal.getViewportY();

        const total = remainderPx + deltaPixels;
        const lines = Math.trunc(total / lineHeightPx);
        remainderPx = total - lines * lineHeightPx;

        if (lines !== 0) {
          // Touch delta is in pixels, convert to lines.
          // Natural mobile scrolling: finger up scrolls down.
          terminal.scrollLines(lines);
        }

        const after = terminal.getViewportY();
        return after !== before;
      };

      const stopKinetic = () => {
        if (state.rafId !== null && typeof window !== 'undefined') {
          window.cancelAnimationFrame(state.rafId);
        }
        state.rafId = null;
      };

      const listenerOptions: AddEventListenerOptions = { passive: false, capture: false };
      const supportsPointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;

      if (supportsPointerEvents) {
        const stateWithPointerId = Object.assign(state, {
          pointerId: null as number | null,
          startX: null as number | null,
          startY: null as number | null,
          moved: false,
        });

        const TAP_MOVE_THRESHOLD_PX = 6;

        const handlePointerDown = (event: PointerEvent) => {
          if (event.pointerType !== 'touch') {
            return;
          }
          stopKinetic();
          stateWithPointerId.pointerId = event.pointerId;
          stateWithPointerId.startX = event.clientX;
          stateWithPointerId.startY = event.clientY;
          stateWithPointerId.moved = false;
          stateWithPointerId.lastY = event.clientY;
          stateWithPointerId.lastTime = nowMs();
          stateWithPointerId.velocity = 0;
          try {
            container.setPointerCapture(event.pointerId);
          } catch { /* ignored */ }
        };

        const handlePointerMove = (event: PointerEvent) => {
          if (event.pointerType !== 'touch' || stateWithPointerId.pointerId !== event.pointerId) {
            return;
          }

          if (stateWithPointerId.startX !== null && stateWithPointerId.startY !== null && !stateWithPointerId.moved) {
            const dx = event.clientX - stateWithPointerId.startX;
            const dy = event.clientY - stateWithPointerId.startY;
            if (Math.hypot(dx, dy) >= TAP_MOVE_THRESHOLD_PX) {
              stateWithPointerId.moved = true;
            }
          }

          if (stateWithPointerId.lastY === null) {
            stateWithPointerId.lastY = event.clientY;
            stateWithPointerId.lastTime = nowMs();
            return;
          }

          const previousY = stateWithPointerId.lastY;
          const previousTime = stateWithPointerId.lastTime ?? nowMs();
          const currentTime = nowMs();
          stateWithPointerId.lastY = event.clientY;
          stateWithPointerId.lastTime = currentTime;

          const deltaY = previousY - event.clientY;
          if (Math.abs(deltaY) < 1) {
            return;
          }

          const dt = Math.max(currentTime - previousTime, 8);
          const scrollMultiplier = baseScrollMultiplier + Math.min(maxScrollBoost, Math.abs(deltaY) / boostDenominator);
          const deltaPixels = deltaY * scrollMultiplier;
          const instantVelocity = deltaPixels / dt;
          stateWithPointerId.velocity = stateWithPointerId.velocity * (1 - velocityAlpha) + instantVelocity * velocityAlpha;

          if (stateWithPointerId.velocity > maxVelocity) {
            stateWithPointerId.velocity = maxVelocity;
          } else if (stateWithPointerId.velocity < -maxVelocity) {
            stateWithPointerId.velocity = -maxVelocity;
          }

          // Only prevent default once we're actually scrolling.
          if (stateWithPointerId.moved) {
            if (event.cancelable) {
              event.preventDefault();
            }
            event.stopPropagation();
          }

          scrollByPixels(deltaPixels);
        };

        const handlePointerUp = (event: PointerEvent) => {
          if (event.pointerType !== 'touch' || stateWithPointerId.pointerId !== event.pointerId) {
            return;
          }

          const wasTap = !stateWithPointerId.moved;

          stateWithPointerId.pointerId = null;
          stateWithPointerId.startX = null;
          stateWithPointerId.startY = null;
          stateWithPointerId.moved = false;
          stateWithPointerId.lastY = null;
          stateWithPointerId.lastTime = null;
          try {
            container.releasePointerCapture(event.pointerId);
          } catch { /* ignored */ }

          if (wasTap) {
            if (useHiddenInputOverlay) {
              focusHiddenInput(event.clientX, event.clientY);
            } else {
              terminalRef.current?.focus();
            }
            return;
          }

          if (typeof window === 'undefined') {
            return;
          }

          if (Math.abs(stateWithPointerId.velocity) < minVelocity) {
            stateWithPointerId.velocity = 0;
            return;
          }

          let lastFrame = nowMs();
          const step = () => {
            const frameTime = nowMs();
            const dt = Math.max(frameTime - lastFrame, 8);
            lastFrame = frameTime;

            const moved = scrollByPixels(stateWithPointerId.velocity * dt) ?? false;

            const sign = Math.sign(stateWithPointerId.velocity);
            const nextMagnitude = Math.max(0, Math.abs(stateWithPointerId.velocity) - deceleration * dt);
            stateWithPointerId.velocity = nextMagnitude * sign;

            if (!moved || nextMagnitude <= minVelocity) {
              stopKinetic();
              stateWithPointerId.velocity = 0;
              return;
            }

            stateWithPointerId.rafId = window.requestAnimationFrame(step);
          };

          stateWithPointerId.rafId = window.requestAnimationFrame(step);
        };

        container.addEventListener('pointerdown', handlePointerDown, listenerOptions);
        container.addEventListener('pointermove', handlePointerMove, listenerOptions);
        container.addEventListener('pointerup', handlePointerUp, listenerOptions);
        container.addEventListener('pointercancel', handlePointerUp, listenerOptions);

        const previousTouchAction = container.style.touchAction;
        container.style.touchAction = 'manipulation';

        touchScrollCleanupRef.current = () => {
          stopKinetic();
          if (viewportDiscoveryTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(viewportDiscoveryTimeoutRef.current);
            viewportDiscoveryTimeoutRef.current = null;
          }
          viewportDiscoveryAttemptsRef.current = 0;
          container.removeEventListener('pointerdown', handlePointerDown, listenerOptions);
          container.removeEventListener('pointermove', handlePointerMove, listenerOptions);
          container.removeEventListener('pointerup', handlePointerUp, listenerOptions);
          container.removeEventListener('pointercancel', handlePointerUp, listenerOptions);
          container.style.touchAction = previousTouchAction;
        };

        return;
      }

      const TAP_MOVE_THRESHOLD_PX = 6;

      const handleTouchStart = (event: TouchEvent) => {
        if (event.touches.length !== 1) {
          return;
        }
        stopKinetic();
        state.lastY = event.touches[0].clientY;
        state.lastTime = nowMs();
        state.velocity = 0;
        state.startX = event.touches[0].clientX;
        state.startY = event.touches[0].clientY;
        state.didMove = false;
      };

      const handleTouchMove = (event: TouchEvent) => {
        if (event.touches.length !== 1) {
          state.lastY = null;
          state.lastTime = null;
          state.velocity = 0;
          state.startX = null;
          state.startY = null;
          state.didMove = false;
          stopKinetic();
          return;
        }

        const currentX = event.touches[0].clientX;
        const currentY = event.touches[0].clientY;

        if (state.startX !== null && state.startY !== null && !state.didMove) {
          const dx = currentX - state.startX;
          const dy = currentY - state.startY;
          if (Math.hypot(dx, dy) >= TAP_MOVE_THRESHOLD_PX) {
            state.didMove = true;
          }
        }

        if (state.lastY === null) {
          state.lastY = currentY;
          state.lastTime = nowMs();
          return;
        }

        const previousY = state.lastY;
        const previousTime = state.lastTime ?? nowMs();
        const currentTime = nowMs();
        state.lastY = currentY;
        state.lastTime = currentTime;

        const deltaY = previousY - currentY;
        if (Math.abs(deltaY) < 1) {
          return;
        }

        const dt = Math.max(currentTime - previousTime, 8);
        const scrollMultiplier = baseScrollMultiplier + Math.min(maxScrollBoost, Math.abs(deltaY) / boostDenominator);
        const deltaPixels = deltaY * scrollMultiplier;
        const instantVelocity = deltaPixels / dt;
        state.velocity = state.velocity * (1 - velocityAlpha) + instantVelocity * velocityAlpha;

        if (state.velocity > maxVelocity) {
          state.velocity = maxVelocity;
        } else if (state.velocity < -maxVelocity) {
          state.velocity = -maxVelocity;
        }

        if (state.didMove) {
          event.preventDefault();
          event.stopPropagation();
        }

        scrollByPixels(deltaPixels);
      };

      const handleTouchEnd = (event: TouchEvent) => {
        const wasTap = !state.didMove;

        state.lastY = null;
        state.lastTime = null;

        const velocity = state.velocity;
        state.startX = null;
        state.startY = null;
        state.didMove = false;

        if (wasTap) {
          const point = event.changedTouches?.[0];
          if (useHiddenInputOverlay) {
            focusHiddenInput(point?.clientX, point?.clientY);
          } else {
            terminalRef.current?.focus();
          }
          return;
        }

        if (typeof window === 'undefined') {
          return;
        }

        if (Math.abs(velocity) < minVelocity) {
          state.velocity = 0;
          return;
        }

        let lastFrame = nowMs();
        const step = () => {
          const frameTime = nowMs();
          const dt = Math.max(frameTime - lastFrame, 8);
          lastFrame = frameTime;

          const moved = scrollByPixels(state.velocity * dt) ?? false;

          const sign = Math.sign(state.velocity);
          const nextMagnitude = Math.max(0, Math.abs(state.velocity) - deceleration * dt);
          state.velocity = nextMagnitude * sign;

          if (!moved || nextMagnitude <= minVelocity) {
            stopKinetic();
            state.velocity = 0;
            return;
          }

          state.rafId = window.requestAnimationFrame(step);
        };

        state.rafId = window.requestAnimationFrame(step);
      };

      container.addEventListener('touchstart', handleTouchStart, listenerOptions);
      container.addEventListener('touchmove', handleTouchMove, listenerOptions);
      container.addEventListener('touchend', handleTouchEnd as unknown as EventListener, listenerOptions);
      container.addEventListener('touchcancel', handleTouchEnd as unknown as EventListener, listenerOptions);

      const previousTouchAction = container.style.touchAction;
      container.style.touchAction = 'manipulation';

      touchScrollCleanupRef.current = () => {
        stopKinetic();
        if (viewportDiscoveryTimeoutRef.current !== null && typeof window !== 'undefined') {
          window.clearTimeout(viewportDiscoveryTimeoutRef.current);
          viewportDiscoveryTimeoutRef.current = null;
        }
        viewportDiscoveryAttemptsRef.current = 0;
        container.removeEventListener('touchstart', handleTouchStart, listenerOptions);
        container.removeEventListener('touchmove', handleTouchMove, listenerOptions);
        container.removeEventListener('touchend', handleTouchEnd as unknown as EventListener, listenerOptions);
        container.removeEventListener('touchcancel', handleTouchEnd as unknown as EventListener, listenerOptions);
        container.style.touchAction = previousTouchAction;
      };
    }, [enableTouchScroll, useHiddenInputOverlay, focusHiddenInput, fontSize]);

    React.useEffect(() => {
      let disposed = false;
      let localTerminal: GhosttyTerminal | null = null;
      let localResizeObserver: ResizeObserver | null = null;
      let localTextareaObserver: MutationObserver | null = null;
      let localDisposables: Array<{ dispose: () => void }> = [];
      let restorePatchedScrollToBottom: (() => void) | null = null;

      const container = containerRef.current;
      if (!container) {
        return;
      }

      container.tabIndex = useHiddenInputOverlay ? -1 : 0;

      const handleTerminalTextareaFocus = () => {
        setTerminalCursorBlink(true);
      };

      const handleTerminalTextareaBlur = () => {
        setTerminalCursorBlink(false);
      };

      const handleDocumentFocusIn = (event: FocusEvent) => {
        const target = event.target as Node | null;
        if (target && container.contains(target)) {
          setTerminalCursorBlink(true);
          return;
        }
        setTerminalCursorBlink(false);
      };

      const handleWindowBlur = () => {
        setTerminalCursorBlink(false);
      };

      let localTerminalTextarea: HTMLTextAreaElement | null = null;

      const initialize = async () => {
        try {
          const ghostty = await getGhostty();
          if (disposed) {
            return;
          }

          const options = getGhosttyTerminalOptions(fontFamily, fontSize, theme, ghostty, false);

          const terminal = new GhosttyTerminal(options);
          followOutputRef.current = true;

          const terminalWithViewport = terminal as unknown as TerminalWithViewport;
          if (typeof terminalWithViewport.scrollToBottom === 'function') {
            const originalScrollToBottom = terminalWithViewport.scrollToBottom.bind(terminalWithViewport);
            terminalWithViewport.scrollToBottom = () => {
              if (followOutputRef.current) {
                originalScrollToBottom();
              }
            };
            restorePatchedScrollToBottom = () => {
              terminalWithViewport.scrollToBottom = originalScrollToBottom;
            };
          }

          const fitAddon = new FitAddon();

          localTerminal = terminal;
          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;

          terminal.loadAddon(fitAddon);
          terminal.open(container);
          bumpTerminalReady();
          cursorBlinkStateRef.current = false;

          localTerminalTextarea =
            (terminal as unknown as { textarea?: HTMLTextAreaElement | null }).textarea
            ?? container.querySelector('textarea');

          if (localTerminalTextarea) {
            localTerminalTextarea.addEventListener('focus', handleTerminalTextareaFocus);
            localTerminalTextarea.addEventListener('blur', handleTerminalTextareaBlur);
          }

          disableTerminalTextareas();

          if (typeof MutationObserver !== 'undefined') {
            localTextareaObserver = new MutationObserver(() => {
              disableTerminalTextareas();
            });
            localTextareaObserver.observe(container, { childList: true, subtree: true });
          }

          const viewport = findScrollableViewport(container);
          if (viewport) {
            viewport.classList.add('overlay-scrollbar-target', 'overlay-scrollbar-container');
            viewportRef.current = viewport;
            forceRender();
          } else {
            viewportRef.current = null;
          }

          fitTerminal();
          const fitAddonWithResize = fitAddon as FitAddonWithObserveResize;
          if (typeof fitAddonWithResize.observeResize === 'function') {
            fitAddonWithResize.observeResize();
          }
          setupTouchScroll();
          localDisposables = [
            terminal.onData((data: string) => {
              inputHandlerRef.current(data);
            }),
            terminal.onScroll((viewportY: number) => {
              if (typeof viewportY === 'number' && Number.isFinite(viewportY)) {
                const hasSelection = typeof terminal.hasSelection === 'function' && terminal.hasSelection();
                followOutputRef.current = !hasSelection && viewportY <= 0.5;
              }
            }),
            terminal.onSelectionChange(() => {
              const hasSelection = typeof terminal.hasSelection === 'function' && terminal.hasSelection();
              if (hasSelection) {
                followOutputRef.current = false;
                return;
              }

              const viewportY = typeof terminal.getViewportY === 'function' ? terminal.getViewportY() : 0;
              followOutputRef.current = viewportY <= 0.5;
            }),
          ];

          localResizeObserver = new ResizeObserver(() => {
            fitTerminal();
          });
          localResizeObserver.observe(container);

          if (typeof window !== 'undefined') {
            window.setTimeout(() => {
              fitTerminal();
            }, 0);
          }
        } catch {
          // ignored
        }
      };

      void initialize();

      document.addEventListener('focusin', handleDocumentFocusIn, true);
      window.addEventListener('blur', handleWindowBlur);

      return () => {
        disposed = true;
        touchScrollCleanupRef.current?.();
        touchScrollCleanupRef.current = null;

        document.removeEventListener('focusin', handleDocumentFocusIn, true);
        window.removeEventListener('blur', handleWindowBlur);

        localDisposables.forEach((disposable) => disposable.dispose());
        restorePatchedScrollToBottom?.();
        restorePatchedScrollToBottom = null;
        if (localTerminalTextarea) {
          localTerminalTextarea.removeEventListener('focus', handleTerminalTextareaFocus);
          localTerminalTextarea.removeEventListener('blur', handleTerminalTextareaBlur);
        }
        localResizeObserver?.disconnect();
        localTextareaObserver?.disconnect();

        localTerminal?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        viewportRef.current = null;
        lastReportedSizeRef.current = null;
        cursorBlinkStateRef.current = null;
        resetWriteState();
      };
    }, [disableTerminalTextareas, fitTerminal, fontFamily, fontSize, setupTouchScroll, theme, resetWriteState, setTerminalCursorBlink, useHiddenInputOverlay]);


    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      terminal.reset();
      resetWriteState();
      lastReportedSizeRef.current = null;
      fitTerminal();
    }, [sessionKey, terminalReadyVersion, fitTerminal, resetWriteState]);

    React.useEffect(() => {
      if (!autoFocus) {
        return;
      }

      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      focusTerminalInput();
    }, [autoFocus, focusTerminalInput, sessionKey, terminalReadyVersion]);

    React.useEffect(() => {
      setupTouchScroll();
      return () => {
        touchScrollCleanupRef.current?.();
        touchScrollCleanupRef.current = null;
      };
    }, [setupTouchScroll, sessionKey]);

    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      if (chunks.length === 0) {
        if (lastProcessedChunkIdRef.current !== null) {
          terminal.reset();
          resetWriteState();
          fitTerminal();
        }
        return;
      }

      const lastProcessedId = lastProcessedChunkIdRef.current;
      let pending: TerminalChunk[];

      if (lastProcessedId === null) {
        pending = chunks;
      } else {
        const lastProcessedIndex = chunks.findIndex((chunk) => chunk.id === lastProcessedId);
        pending = lastProcessedIndex >= 0 ? chunks.slice(lastProcessedIndex + 1) : chunks;
      }

      if (pending.length > 0) {
        enqueueWrite(pending.map((chunk) => chunk.data).join(''));
      }

      lastProcessedChunkIdRef.current = chunks[chunks.length - 1].id;
    }, [chunks, terminalReadyVersion, enqueueWrite, fitTerminal, resetWriteState]);

    React.useImperativeHandle(
      ref,
      (): TerminalController => ({
        focus: () => {
          focusTerminalInput();
        },
        clear: () => {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          terminal.reset();
          resetWriteState();
          fitTerminal();
        },
        fit: () => {
          fitTerminal();
        },
      }),
      [focusTerminalInput, fitTerminal, resetWriteState]
    );

    const handleHiddenInputBlur = React.useCallback(
      (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (!useHiddenInputOverlay) {
          return;
        }

        const related = event.relatedTarget as HTMLElement | null;
        const relatedTag = related?.tagName;
        const isInput = relatedTag === 'INPUT' || relatedTag === 'TEXTAREA' || related?.isContentEditable;
        const isHiddenInput = related?.getAttribute('data-terminal-hidden-input') === 'true';
        if (isInput && !isHiddenInput) {
          if (refocusTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(refocusTimeoutRef.current);
          }
          if (typeof window !== 'undefined') {
            refocusTimeoutRef.current = window.setTimeout(() => {
              refocusTimeoutRef.current = null;
              focusHiddenInput();
            }, 0);
          }
        }
      },
      [useHiddenInputOverlay, focusHiddenInput]
    );

    const handleHiddenBeforeInput = React.useCallback(
      (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const nativeEvent = event.nativeEvent as InputEvent | undefined;
        const inputType = nativeEvent?.inputType ?? '';
        const data = typeof nativeEvent?.data === 'string' ? nativeEvent.data : '';

        lastInputEventAtRef.current = typeof performance !== 'undefined'
          ? performance.now()
          : Date.now();

        if (inputType === 'insertCompositionText') {
          isComposingRef.current = true;
          return;
        }

        if (!inputType && data) {
          if (isComposingRef.current) {
            return;
          }
          event.preventDefault();
          inputHandlerRef.current(data);
          lastBeforeInputRef.current = {
            type: 'insertText',
            at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
          };
          ignoreNextInputRef.current = true;
          return;
        }

        if (inputType === 'insertText' && data) {
          if (isComposingRef.current) {
            return;
          }
          event.preventDefault();
          inputHandlerRef.current(data);
          lastBeforeInputRef.current = {
            type: inputType,
            at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
          };
          ignoreNextInputRef.current = true;
          return;
        }

        if (inputType === 'insertLineBreak') {
          if (isComposingRef.current) {
            return;
          }
          event.preventDefault();
          inputHandlerRef.current('\r');
          lastBeforeInputRef.current = {
            type: inputType,
            at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
          };
          ignoreNextInputRef.current = true;
          return;
        }

        if (inputType === 'deleteContentBackward') {
          if (isComposingRef.current) {
            return;
          }
          event.preventDefault();
          inputHandlerRef.current('\x7f');
          lastBeforeInputRef.current = {
            type: inputType,
            at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
          };
          ignoreNextInputRef.current = true;
        }
      },
      []
    );

    const handleHiddenInput = React.useCallback(
      (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const target = event.currentTarget as HTMLElement;
        lastInputEventAtRef.current = typeof performance !== 'undefined'
          ? performance.now()
          : Date.now();
        if (isComposingRef.current) {
          return;
        }
        if (ignoreNextInputRef.current) {
          const lastBeforeInput = lastBeforeInputRef.current;
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          if (lastBeforeInput && now - lastBeforeInput.at < 50) {
            ignoreNextInputRef.current = false;
            clearEditableValue(target);
            return;
          }
          ignoreNextInputRef.current = false;
        }
        const raw = readEditableValue(target);
        if (!raw) {
          return;
        }

        lastObservedValueRef.current = raw;

        const value = raw.replace(/\r\n|\r|\n/g, '\r');
        inputHandlerRef.current(value);
        clearEditableValue(target);
        lastObservedValueRef.current = '';
      },
      [clearEditableValue, readEditableValue]
    );

    const handleHiddenKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        event.stopPropagation();

        const normalizedKey = event.key.toLowerCase();
        const isMacCopyShortcut = event.metaKey && !event.ctrlKey && !event.altKey && normalizedKey === 'c';
        const isWindowsLinuxCopyShortcut =
          event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && normalizedKey === 'c';

        if ((isMacCopyShortcut || isWindowsLinuxCopyShortcut) && hasCopyableSelectionInViewport()) {
          event.preventDefault();
          void copySelectionToClipboard();
          return;
        }

        const target = event.currentTarget as HTMLElement;
        const nativeEvent = event.nativeEvent as KeyboardEvent | undefined;
        if (nativeEvent?.isComposing) {
          return;
        }
        const lastBeforeInput = lastBeforeInputRef.current;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const recent = Boolean(lastBeforeInput && now - lastBeforeInput.at < 50);
        if (event.key === 'Enter') {
          if (recent && lastBeforeInput?.type === 'insertLineBreak') {
            return;
          }
          event.preventDefault();
          inputHandlerRef.current('\r');
          clearEditableValue(target);
          return;
        }
        if (event.key === 'Backspace') {
          event.preventDefault();
          if (recent && lastBeforeInput?.type === 'deleteContentBackward') {
            return;
          }
          if (!readEditableValue(target)) {
            inputHandlerRef.current('\x7f');
          }
        }

        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const lastInputAt = lastInputEventAtRef.current;
          const sawInputRecently = Boolean(lastInputAt && now - lastInputAt < 50);
          if (!sawInputRecently) {
            event.preventDefault();
            inputHandlerRef.current(event.key);
            ignoreNextInputRef.current = true;
            lastBeforeInputRef.current = {
              type: 'keydown-text',
              at: now,
            };
          }
        }

        scheduleKeyProbe(target);
      },
      [clearEditableValue, copySelectionToClipboard, hasCopyableSelectionInViewport, readEditableValue, scheduleKeyProbe]
    );

    const handleHiddenKeyUp = React.useCallback(
      (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        event.stopPropagation();
        const target = event.currentTarget as HTMLElement;
        const nativeEvent = event.nativeEvent as KeyboardEvent | undefined;
        if (nativeEvent?.isComposing) {
          return;
        }
        scheduleKeyProbe(target);
      },
      [scheduleKeyProbe]
    );

    const handleHiddenCompositionEnd = React.useCallback(
      (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const target = event.currentTarget as HTMLElement;
        isComposingRef.current = false;
        const data = event.data || readEditableValue(target);
        lastInputEventAtRef.current = typeof performance !== 'undefined'
          ? performance.now()
          : Date.now();
        if (!data) {
          return;
        }
        const value = data.replace(/\r\n|\r|\n/g, '\r');
        inputHandlerRef.current(value);
        clearEditableValue(target);
        lastBeforeInputRef.current = {
          type: 'compositionend',
          at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        };
        ignoreNextInputRef.current = true;
      },
      [clearEditableValue, readEditableValue]
    );

    const handleHiddenPaste = React.useCallback(
      (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        event.stopPropagation();
        const text = event.clipboardData?.getData('text') ?? '';
        if (!text) {
          return;
        }
        event.preventDefault();
        const terminal = terminalRef.current;
        const payload = terminal?.hasBracketedPaste?.()
          ? `\x1b[200~${text}\x1b[201~`
          : text;
        inputHandlerRef.current(payload);
      },
      []
    );

    const hiddenInputStyle: React.CSSProperties = {
      position: 'fixed',
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      opacity: 0,
      zIndex: -1,
      background: 'transparent',
      color: 'transparent',
      WebkitTextFillColor: 'transparent',
      caretColor: 'transparent',
      textShadow: 'none',
      WebkitAppearance: 'none',
      appearance: 'none',
      resize: 'none',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      border: '0',
      padding: 0,
      margin: 0,
      outline: 'none',
      outlineOffset: 0,
      fontSize: 16,
      fontWeight: 400,
      pointerEvents: 'none',
      WebkitUserSelect: 'none',
      userSelect: 'none',
    };

    return (
      <div
        ref={containerRef}
        className={cn('relative h-full w-full terminal-viewport-container', className)}
        style={{ backgroundColor: theme.background }}
        onTouchStart={(event) => {
          if (!useHiddenInputOverlay || enableTouchScroll) {
            return;
          }
          if (!hasCopyableSelectionInViewport()) {
            const touch = event.touches?.[0];
            focusHiddenInput(touch?.clientX, touch?.clientY);
          }
        }}
        onClick={(event) => {
          if (useHiddenInputOverlay) {
            if (enableTouchScroll) {
              return;
            }
            if (hasCopyableSelectionInViewport()) {
              return;
            }
            focusHiddenInput(event.clientX, event.clientY);
          } else {
            terminalRef.current?.focus();
          }
        }}
        onMouseUp={() => {
          if (!enableTouchScroll && hasCopyableSelectionInViewport()) {
            void copySelectionToClipboard();
          }
        }}
        onTouchEnd={() => {
          if (!enableTouchScroll && hasCopyableSelectionInViewport()) {
            void copySelectionToClipboard();
          }
        }}
      >
        {useHiddenInputOverlay && typeof document !== 'undefined'
          ? createPortal(
            <>
              <input
                ref={textInputRef}
                type="text"
                inputMode="text"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                tabIndex={-1}
                enterKeyHint="send"
                data-terminal-hidden-input="true"
                data-keyboard-avoid-target-id={keyboardAvoidTargetId}
                aria-label="Terminal input"
                aria-hidden="true"
                style={{
                  ...hiddenInputStyle,
                  display: useTextInput ? 'block' : 'none',
                }}
                onBlur={handleHiddenInputBlur}
                onBeforeInput={handleHiddenBeforeInput}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onInput={handleHiddenInput}
                onKeyDown={handleHiddenKeyDown}
                onKeyUp={handleHiddenKeyUp}
                onCompositionEnd={handleHiddenCompositionEnd}
                onPaste={handleHiddenPaste}
              />
              <textarea
                ref={hiddenInputRef}
                inputMode="text"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                tabIndex={-1}
                enterKeyHint="send"
                data-terminal-hidden-input="true"
                data-keyboard-avoid-target-id={keyboardAvoidTargetId}
                aria-label="Terminal input"
                aria-hidden="true"
                style={{
                  ...hiddenInputStyle,
                  display: useTextInput ? 'none' : 'block',
                }}
                onBlur={handleHiddenInputBlur}
                onBeforeInput={handleHiddenBeforeInput}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onInput={handleHiddenInput}
                onKeyDown={handleHiddenKeyDown}
                onKeyUp={handleHiddenKeyUp}
                onCompositionEnd={handleHiddenCompositionEnd}
                onPaste={handleHiddenPaste}
              />
            </>,
            document.body
            )
          : null}
        {viewportRef.current && !enableTouchScroll ? (
          <OverlayScrollbar
            containerRef={viewportRef}
            disableHorizontal
            className="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
          />
        ) : null}
      </div>
    );
  }
);

TerminalViewport.displayName = 'TerminalViewport';

export type { TerminalController };
export { TerminalViewport };
