import { registerPlugin } from '@capacitor/core';
import React from 'react';

import { observeNativeKeyboardHeight, resetHardwareKeyboardDetection, startHardwareKeyboardBridge } from '@/lib/hardwareKeyboard';
import { hasOpenBackLayer, subscribeBackLayers } from '@/lib/mobileBackLayers';
import { KEYBOARD_EASING_CSS, KEYBOARD_HIDE_MS, KEYBOARD_SHOW_MS, keyboardKeyframes } from '@/lib/mobileKeyboardTiming';
import { writeMobileKeyboardVar } from '@/lib/mobileKeyboardInsets';
import { isBackGuardEntry, pushBackGuard } from '@/lib/router/backGuard';
import { useUIStore } from '@/stores/useUIStore';

export const isCapacitorMobileApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const maybeCapacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (maybeCapacitor?.isNativePlatform?.() === true) return true;
  return window.location.protocol === 'capacitor:';
};

interface WindowLayoutPlugin {
  get(): Promise<{ edgeToEdge: boolean }>;
}

const WindowLayout = registerPlugin<WindowLayoutPlugin>('WindowLayout');

export const useNativeMobileChrome = (): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const root = document.documentElement;
    root.classList.add('oc-capacitor-app');
    const capacitorPlatform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    if (capacitorPlatform === 'android') {
      root.classList.add('oc-platform-android');
    }

    cleanup.push(startHardwareKeyboardBridge());

    const setInset = (px: number) => {
      writeMobileKeyboardVar('--oc-keyboard-inset', px);
    };

    void import('@capacitor/status-bar').then(async ({ StatusBar, Style }) => {
      if (disposed) return;
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      const applyStatusBar = async () => {
        if (platform === 'android') {
          const isDark = document.documentElement.classList.contains('dark');
          const themeBg =
            (isDark ? localStorage.getItem('splashBgDark') : localStorage.getItem('splashBgLight')) ||
            (isDark ? '#171515' : '#fffdf4');
          const overlayOff = await StatusBar.setOverlaysWebView({ overlay: false }).then(() => true, () => false);
          const edgeToEdge = await WindowLayout.get().then(({ edgeToEdge }) => edgeToEdge, () => true);
          if (overlayOff && !edgeToEdge) {
            root.classList.add('oc-android-below-status-bar');
          }
          await StatusBar.setBackgroundColor({ color: themeBg }).catch(() => undefined);
          await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light }).catch(() => undefined);
          await StatusBar.show().catch(() => undefined);
          return;
        }
        await StatusBar.setStyle({ style: Style.Default }).catch(() => undefined);
        await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
        await StatusBar.show().catch(() => undefined);
      };
      await applyStatusBar();
      const retry = window.setTimeout(() => void applyStatusBar(), 400);
      cleanup.push(() => window.clearTimeout(retry));

      if (platform === 'android') {
        let wasDark = root.classList.contains('dark');
        const themeClassObserver = new MutationObserver(() => {
          const isDark = root.classList.contains('dark');
          if (isDark === wasDark) return;
          wasDark = isDark;
          void applyStatusBar();
        });
        themeClassObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
        if (disposed) {
          themeClassObserver.disconnect();
          return;
        }
        cleanup.push(() => themeClassObserver.disconnect());
      }

      const { App } = await import('@capacitor/app');
      const stateHandle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void applyStatusBar();
      });
      if (disposed) {
        void stateHandle.remove();
        return;
      }
      cleanup.push(() => void stateHandle.remove());
    }).catch(() => undefined);

    void import('@capacitor/keyboard').then(async ({ Keyboard }) => {
      if (disposed) return;
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      if (platform === 'android') {
        const willShowHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
          observeNativeKeyboardHeight(info.keyboardHeight);
          root.classList.add('oc-keyboard-open');
          window.dispatchEvent(new CustomEvent('oc:keyboard-settled', { detail: { open: true } }));
        });
        const didShowHandle = await Keyboard.addListener('keyboardDidShow', () => {
          window.dispatchEvent(new CustomEvent('oc:keyboard-settled', { detail: { open: true } }));
        });
        const willHideHandle = await Keyboard.addListener('keyboardWillHide', () => {
          window.dispatchEvent(new CustomEvent('oc:keyboard-intent', { detail: { open: false } }));
          root.classList.remove('oc-keyboard-open');
        });
        const didHideHandle = await Keyboard.addListener('keyboardDidHide', () => {
          window.dispatchEvent(new CustomEvent('oc:keyboard-settled', { detail: { open: false } }));
        });
        const removeAll = () => {
          void willShowHandle.remove();
          void didShowHandle.remove();
          void willHideHandle.remove();
          void didHideHandle.remove();
        };
        if (disposed) {
          removeAll();
          return;
        }
        cleanup.push(removeAll);
        return;
      }
      await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);

      const KB_ANIM_MS = KEYBOARD_SHOW_MS;
      const KB_HIDE_MS = KEYBOARD_HIDE_MS;
      const KB_ANIM_EASING = KEYBOARD_EASING_CSS;
      let settleTimer: number | null = null;
      let caretTimer: number | null = null;
      let keyboardHeight = 0;
      let layoutApplied = false;
      let safeBottomPx = 0;
      let keyboardOpen = false;
      let keyboardInShell = true;

      const setVar = (name: '--oc-kb-layout' | '--oc-kb-surface' | '--oc-kb-scroll-inset', px: number) => {
        writeMobileKeyboardVar(name, px);
      };
      const clearSettle = () => {
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer);
          settleTimer = null;
        }
      };
      const dispatchKb = (type: 'oc:keyboard-intent' | 'oc:keyboard-anim' | 'oc:keyboard-settled', detail: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent(type, { detail }));
      };
      type KbMover = { el: HTMLElement; factor: number; base: 'shell' | 'keyboard' };
      const getKbMovers = (): KbMover[] => {
        const movers: KbMover[] = [];
        const composer = keyboardInShell ? document.querySelector<HTMLElement>('.oc-mobile-composer') : null;
        if (composer) movers.push({ el: composer, factor: 1, base: 'shell' });
        const riders = keyboardInShell ? document.querySelector<HTMLElement>('.oc-composer-riders') : null;
        if (riders) movers.push({ el: riders, factor: 1, base: 'shell' });
        const draftCenter = keyboardInShell ? document.querySelector<HTMLElement>('.oc-draft-center') : null;
        if (draftCenter) movers.push({ el: draftCenter, factor: 0.5, base: 'shell' });
        for (const el of document.querySelectorAll<HTMLElement>('[data-keyboard-rider]')) {
          const inShell = el.closest('.oc-mobile-app-shell') !== null;
          if (inShell && !keyboardInShell) continue;
          movers.push({ el, factor: Number(el.dataset.keyboardRider) || 1, base: inShell ? 'shell' : 'keyboard' });
        }
        return movers;
      };
      const travel = (mover: KbMover, slide: number) => (mover.base === 'shell' ? slide : keyboardHeight) * mover.factor;
      const moverAnimations = new WeakMap<HTMLElement, Animation>();
      const moverShift = (el: HTMLElement): number => {
        const transform = getComputedStyle(el).transform;
        return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
      };
      const slideMovers = (durationMs: number, from: (mover: KbMover) => number, to: (mover: KbMover) => number) => {
        const movers = getKbMovers();
        const starts = movers.map((mover) => from(mover));
        movers.forEach((mover, index) => {
          const { el } = mover;
          moverAnimations.get(el)?.cancel();
          const start = starts[index];
          const end = to(mover);
          el.style.transition = '';
          el.style.transform = `translateY(${end}px)`;
          if (Math.abs(end - start) < 0.5) return;
          moverAnimations.set(el, el.animate(
            keyboardKeyframes((position) => ({ transform: `translateY(${start + (end - start) * position}px)` })),
            { duration: durationMs, easing: 'linear' },
          ));
        });
      };
      const clearKbMovers = () => {
        for (const { el } of getKbMovers()) {
          moverAnimations.get(el)?.cancel();
          el.style.transition = '';
          el.style.transform = '';
        }
      };

      const showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
        observeNativeKeyboardHeight(info.keyboardHeight);
        const inShell = document.activeElement?.closest('.oc-mobile-app-shell') != null;
        if (keyboardOpen && layoutApplied && settleTimer === null && inShell === keyboardInShell) {
          if (Math.abs(info.keyboardHeight - keyboardHeight) >= 1) {
            keyboardHeight = info.keyboardHeight;
            setInset(keyboardHeight);
            setVar('--oc-kb-surface', keyboardHeight);
            if (keyboardInShell) {
              setVar('--oc-kb-layout', keyboardHeight);
              setVar('--oc-kb-scroll-inset', Math.max(0, keyboardHeight - safeBottomPx));
            }
            dispatchKb('oc:keyboard-settled', { open: true });
          }
          revealFocusedField('landed');
          return;
        }
        clearSettle();
        dropRevealRoom();
        if (keyboardOpen && keyboardInShell && !inShell) {
          clearKbMovers();
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-scroll-inset', 0);
        }
        keyboardOpen = true;
        keyboardHeight = info.keyboardHeight;
        keyboardInShell = inShell;
        if (!layoutApplied) {
          const shell = document.querySelector('.oc-mobile-app-shell');
          safeBottomPx = shell ? parseFloat(getComputedStyle(shell).paddingBottom) || 0 : 0;
        }
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('oc-kb-hide');
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.add('oc-keyboard-open', 'oc-kb-animating', 'oc-kb-caret-hold');
        setInset(keyboardHeight);
        slideMovers(KB_ANIM_MS, (mover) => moverShift(mover.el), (mover) => -travel(mover, slide));
        if (keyboardInShell) setVar('--oc-kb-scroll-inset', slide);
        dispatchKb('oc:keyboard-anim', { phase: 'show', slide, durationMs: KB_ANIM_MS, easing: KB_ANIM_EASING, inShell: keyboardInShell });
        revealFocusedField('start');
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          root.classList.remove('oc-kb-animating');
          setVar('--oc-kb-surface', keyboardHeight);
          if (keyboardInShell) setVar('--oc-kb-layout', keyboardHeight);
          layoutApplied = true;
          clearKbMovers();
          dispatchKb('oc:keyboard-settled', { open: true });
          revealFocusedField('landed');
          caretTimer = window.setTimeout(() => {
            caretTimer = null;
            root.classList.remove('oc-kb-caret-hold');
          }, 250);
        }, KB_ANIM_MS + 20);
      });

      const runHide = () => {
        if (!keyboardOpen) return;
        keyboardOpen = false;
        clearSettle();
        dropRevealRoom();
        dispatchKb('oc:keyboard-intent', { open: false });
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.remove('oc-kb-caret-hold');
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('oc-keyboard-open');
        setInset(0);
        const wasSettledOpen = layoutApplied;
        if (layoutApplied) {
          root.classList.remove('oc-kb-animating');
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-surface', 0);
          layoutApplied = false;
        }
        dispatchKb('oc:keyboard-anim', { phase: 'hide', slide, durationMs: KB_HIDE_MS, easing: KB_ANIM_EASING, inShell: keyboardInShell });
        root.classList.add('oc-kb-animating', 'oc-kb-hide');
        slideMovers(KB_HIDE_MS, (mover) => (wasSettledOpen ? -travel(mover, slide) : moverShift(mover.el)), () => 0);
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          root.classList.remove('oc-kb-animating', 'oc-kb-hide');
          clearKbMovers();
          setVar('--oc-kb-scroll-inset', 0);
          dispatchKb('oc:keyboard-settled', { open: false });
        }, KB_HIDE_MS + 20);
      };

      const hideHandle = await Keyboard.addListener('keyboardWillHide', runHide);

      const isTextInput = (node: unknown): boolean =>
        node instanceof HTMLElement
        && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable);
      let revealRoom: { scroller: HTMLElement; padding: string } | null = null;
      function dropRevealRoom() {
        if (!revealRoom) return;
        revealRoom.scroller.style.paddingBottom = revealRoom.padding;
        revealRoom = null;
      }
      function revealFocusedField(phase: 'start' | 'landed') {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !isTextInput(field)) return;
        if (field.closest('[data-terminal-owner]')) return;
        const box = field.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || getComputedStyle(field).opacity === '0') return;
        if (phase === 'start' && field.closest('.oc-mobile-composer, [data-keyboard-rider], .oc-keyboard-inset-snap, .chat-scroll')) return;
        let bottom = field.getBoundingClientRect().bottom;
        if (field.isContentEditable) {
          const selection = window.getSelection();
          const caret = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null;
          if (!caret || caret.height === 0) return;
          bottom = caret.bottom;
        }
        const visibleBottom = window.innerHeight - keyboardHeight - 12;
        const overlap = bottom - visibleBottom;
        if (overlap <= 0) return;
        for (let node = field.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const missing = overlap - (node.scrollHeight - node.clientHeight - node.scrollTop);
            if (phase === 'start' && missing > 0) {
              const fieldBottom = field.getBoundingClientRect().bottom;
              revealRoom = { scroller: node, padding: node.style.paddingBottom };
              node.style.paddingBottom = `${(Number.parseFloat(style.paddingBottom) || 0) + missing}px`;
              if (Math.abs(field.getBoundingClientRect().bottom - fieldBottom) > 1) {
                dropRevealRoom();
                return;
              }
            }
            node.scrollBy({ top: overlap, behavior: 'smooth' });
            return;
          }
        }
      }
      const handleFocusOut = (event: FocusEvent) => {
        if (!keyboardOpen) return;
        if (!isTextInput(event.target)) return;
        if (isTextInput(event.relatedTarget)) return;
        window.setTimeout(() => {
          if (!keyboardOpen) return;
          if (isTextInput(document.activeElement)) return;
          runHide();
        }, 0);
      };
      document.addEventListener('focusout', handleFocusOut, true);
      const handleResize = () => {
        if (keyboardOpen && !isTextInput(document.activeElement)) runHide();
      };
      window.addEventListener('resize', handleResize);

      if (disposed) {
        clearSettle();
        document.removeEventListener('focusout', handleFocusOut, true);
        window.removeEventListener('resize', handleResize);
        void showHandle.remove();
        void hideHandle.remove();
        return;
      }
      cleanup.push(
        clearSettle,
        dropRevealRoom,
        () => {
          if (caretTimer !== null) {
            window.clearTimeout(caretTimer);
            caretTimer = null;
          }
        },
        () => document.removeEventListener('focusout', handleFocusOut, true),
        () => window.removeEventListener('resize', handleResize),
        () => void showHandle.remove(),
        () => void hideHandle.remove(),
      );
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
      resetHardwareKeyboardDetection();
      root.classList.remove('oc-capacitor-app', 'oc-keyboard-open', 'oc-kb-animating', 'oc-kb-hide', 'oc-kb-caret-hold', 'oc-platform-android', 'oc-android-below-status-bar');
      writeMobileKeyboardVar('--oc-keyboard-inset', null);
      writeMobileKeyboardVar('--oc-kb-layout', null);
      writeMobileKeyboardVar('--oc-kb-surface', null);
      writeMobileKeyboardVar('--oc-kb-scroll-inset', null);
    };
  }, []);
};

export const useNativeMobileLifecycle = (onResume: () => void): void => {
  const wasInactiveRef = React.useRef(false);

  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const resumeAfterInactive = () => {
      if (!wasInactiveRef.current) return;
      wasInactiveRef.current = false;
      onResume();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasInactiveRef.current = true;
        return;
      }
      resumeAfterInactive();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    cleanup.push(() => document.removeEventListener('visibilitychange', handleVisibility));

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const state = await App.addListener('appStateChange', ({ isActive }) => {
        document.documentElement.classList.toggle('oc-native-app-active', isActive);
        if (!isActive) {
          wasInactiveRef.current = true;
          return;
        }
        resumeAfterInactive();
      });
      const resume = await App.addListener('resume', resumeAfterInactive);
      if (disposed) {
        void state.remove();
        void resume.remove();
        return;
      }
      cleanup.push(() => void state.remove(), () => void resume.remove());
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, [onResume]);
};

export const handleAndroidParentBack = (overviewOpen: boolean, returnToParent: (() => void) | null): boolean => {
  if (overviewOpen || !returnToParent) return false;
  returnToParent();
  return true;
};

export const useMobileBackHandlers = () => {
  const settingsBackRef = React.useRef<(() => boolean) | null>(null);
  const previewBackRef = React.useRef<(() => boolean) | null>(null);
  const parentSessionBackRef = React.useRef<(() => void) | null>(null);
  const registerSettingsBackHandler = React.useCallback((handler: (() => boolean) | null) => { settingsBackRef.current = handler; }, []);
  const registerPreviewBackHandler = React.useCallback((handler: (() => boolean) | null) => { previewBackRef.current = handler; }, []);
  const registerParentSessionBack = React.useCallback((handler: (() => void) | null) => { parentSessionBackRef.current = handler; }, []);
  return { settingsBackRef, previewBackRef, parentSessionBackRef, registerSettingsBackHandler, registerPreviewBackHandler, registerParentSessionBack };
};

export const useAndroidParentSessionBack = (onBack: () => boolean, parentRef: React.RefObject<(() => void) | null>): void => {
  const handleBack = React.useCallback(() => onBack() || handleAndroidParentBack(useUIStore.getState().runOverviewKey !== null, parentRef.current), [onBack, parentRef]);
  useNativeAndroidBackButton(handleBack);
};

const useNativeAndroidBackButton = (onBack: () => boolean): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    let remove: (() => void) | null = null;

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const listener = await App.addListener('backButton', () => {
        if (onBack()) return;
        void App.minimizeApp().catch(() => undefined);
      });
      if (disposed) {
        void listener.remove();
        return;
      }
      remove = () => void listener.remove();
    }).catch(() => undefined);

    return () => {
      disposed = true;
      remove?.();
    };
  }, [onBack]);
};

export const useMobileWebBackButton = (
  handleBack: () => boolean,
  shellLayerOpen: boolean,
): void => {
  const shellLayerOpenRef = React.useRef(shellLayerOpen);
  const onGuardRef = React.useRef(false);
  const retiringGuardRef = React.useRef(false);

  const reconcileGuard = React.useCallback(() => {
    if (retiringGuardRef.current) return;
    const onGuard = isBackGuardEntry();
    const layerOpen = shellLayerOpenRef.current || hasOpenBackLayer();
    onGuardRef.current = onGuard || layerOpen;
    if (layerOpen && !onGuard) {
      pushBackGuard();
    } else if (!layerOpen && onGuard) {
      retiringGuardRef.current = true;
      window.history.back();
    }
  }, []);

  React.useEffect(() => {
    if (isCapacitorMobileApp()) return;
    shellLayerOpenRef.current = shellLayerOpen;
    reconcileGuard();
    return subscribeBackLayers(reconcileGuard);
  }, [reconcileGuard, shellLayerOpen]);

  React.useEffect(() => {
    if (isCapacitorMobileApp()) return;

    const handlePopState = () => {
      const pressedBack = onGuardRef.current && !retiringGuardRef.current && !isBackGuardEntry();
      retiringGuardRef.current = false;
      if (pressedBack && !handleBack()) {
        onGuardRef.current = false;
        return;
      }
      reconcileGuard();
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [handleBack, reconcileGuard]);
};
