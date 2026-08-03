import React from 'react';

/** True when running inside the native Capacitor shell (iOS/Android app). */
export const isCapacitorMobileApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const maybeCapacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (maybeCapacitor?.isNativePlatform?.() === true) return true;
  return window.location.protocol === 'capacitor:';
};

export const useNativeMobileChrome = (): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const root = document.documentElement;
    // Marks the Capacitor shell so keyboard-inset CSS only applies here, not in
    // the browser-hosted PWA (which handles the keyboard via dvh / interactive-widget).
    root.classList.add('oc-capacitor-app');
    // Platform marker: Android resizes the window for the keyboard natively (no manual
    // inset/choreography — the keyboard listeners below skip Android entirely).
    const capacitorPlatform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    if (capacitorPlatform === 'android') {
      root.classList.add('oc-platform-android');
    }

    const setInset = (px: number) => {
      root.style.setProperty('--oc-keyboard-inset', `${Math.max(0, Math.round(px))}px`);
    };

    void import('@capacitor/status-bar').then(async ({ StatusBar, Style }) => {
      if (disposed) return;
      // Keep the status bar transparent over the WebView. A custom UIScene lifecycle
      // (iOS 26) plus returning from background can silently drop the overlay state,
      // letting an opaque status-bar background flash in at the top — so re-assert it
      // on mount, once shortly after (startup race), and whenever the app re-activates.
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      const applyStatusBar = async () => {
        if (platform === 'android') {
          // Inset the WebView below the bar and paint it with the resolved theme background
          // (the splash colours the theme system persists). On Android 15+ edge-to-edge is
          // enforced and both calls are no-ops — there the app pads itself via the
          // Capacitor-injected --safe-area-inset-* CSS vars (see mobile.css, oc-platform-android).
          const isDark = document.documentElement.classList.contains('dark');
          const themeBg =
            (isDark ? localStorage.getItem('splashBgDark') : localStorage.getItem('splashBgLight')) ||
            (isDark ? '#171515' : '#fffdf4');
          await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
          await StatusBar.setBackgroundColor({ color: themeBg }).catch(() => undefined);
          // Capacitor Style is named for the CONTENT: Style.Light = dark text (light bg),
          // Style.Dark = light text (dark bg). So dark theme → Style.Dark, light theme → Style.Light.
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
      // iOS (WKWebView, resize: 'none') keeps 100dvh at full height with the keyboard
      // overlaying, so we lift the UI manually via --oc-keyboard-inset. Android resizes the
      // window for the keyboard (dvh already shrinks), so applying the inset on top would
      // double-count — Android gets only the class/event signals below.
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      if (platform === 'android') {
        // Android resizes the WebView natively, so no inset/transform
        // choreography — but the UI still needs the open/closed signal:
        // oc-keyboard-open drives CSS (draft starters, composer padding), and
        // the settled event gives the chat its one deterministic re-pin after
        // the native resize (the auto-follow idle gate ignores it otherwise).
        const willShowHandle = await Keyboard.addListener('keyboardWillShow', () => {
          root.classList.add('oc-keyboard-open');
          // The composer already expanded on tap — re-pin the chat to it now,
          // so the native resize that follows is the only remaining movement.
          window.dispatchEvent(new CustomEvent('oc:keyboard-settled', { detail: { open: true } }));
        });
        const didShowHandle = await Keyboard.addListener('keyboardDidShow', () => {
          window.dispatchEvent(new CustomEvent('oc:keyboard-settled', { detail: { open: true } }));
        });
        const willHideHandle = await Keyboard.addListener('keyboardWillHide', () => {
          // Same single-motion trick as iOS: collapse the composer into the
          // pill synchronously (flushSync in ChatInput) so the native window
          // growth and the composer shrink land together, not as two steps.
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
      // No WebKit form accessory bar (prev/next arrows + Done) above the keyboard —
      // there's a single input, so it only eats vertical space.
      await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);

      // Keyboard slide choreography (see the "Native (Capacitor) keyboard handling"
      // block in mobile.css for the full picture). `keyboardWillShow` fires at the
      // START of the iOS keyboard animation and carries the final height; the
      // visible motion is transform-only (inline styles on the kb-movers), and the shell's layout
      // height (--oc-kb-layout) snaps exactly once per open/close at the moment the
      // resize is invisible. visualViewport tracking was tried but doesn't shrink
      // under WKWebView's `resize: 'none'`, so these events are the reliable signal.
      const KB_ANIM_MS = 250;
      // Dismissal reads faster than the rise — run the hide leg shorter (kept in
      // sync with the .oc-kb-hide transition-duration override in mobile.css).
      const KB_HIDE_MS = 200;
      const KB_ANIM_EASING = 'cubic-bezier(0.38, 0.7, 0.125, 1)';
      let settleTimer: number | null = null;
      let caretTimer: number | null = null;
      let keyboardHeight = 0;
      let layoutApplied = false;
      let safeBottomPx = 0;
      let keyboardOpen = false;

      const setVar = (name: string, px: number) => {
        root.style.setProperty(name, `${Math.max(0, Math.round(px))}px`);
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
      // Elements that ride the keyboard slide, with their travel factor. Driven
      // by INLINE styles from here: WebKit does not reliably start a transition
      // when the transform's value changes via a CSS custom property, which
      // left the composer parked until the keyboard finished.
      const getKbMovers = (): Array<{ el: HTMLElement; factor: number }> => {
        const movers: Array<{ el: HTMLElement; factor: number }> = [];
        const composer = document.querySelector<HTMLElement>('.oc-mobile-composer');
        if (composer) movers.push({ el: composer, factor: 1 });
        // The centered draft title moves half the shift — exactly where the
        // center lands after the shell snap (see mobile.css notes).
        const draftCenter = document.querySelector<HTMLElement>('.oc-draft-center');
        if (draftCenter) movers.push({ el: draftCenter, factor: 0.5 });
        return movers;
      };
      const clearKbMovers = () => {
        for (const { el } of getKbMovers()) {
          el.style.transition = '';
          el.style.transform = '';
        }
      };

      const showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
        clearSettle();
        keyboardOpen = true;
        keyboardHeight = info.keyboardHeight;
        if (!layoutApplied) {
          // The shell's resolved padding-bottom while the keyboard is down IS the
          // bottom safe padding it gives up when open — measure it so the slide
          // distance lands the composer exactly where the final layout puts it.
          const shell = document.querySelector('.oc-mobile-app-shell');
          safeBottomPx = shell ? parseFloat(getComputedStyle(shell).paddingBottom) || 0 : 0;
        }
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('oc-kb-hide');
        // WKWebView renders the caret as a native layer that doesn't ride CSS
        // transforms — after the rise it visibly "flies" from the pre-keyboard
        // position to the final one. Hide it for the transition (plus the lag
        // window where UIKit animates it into place) and pop it back in.
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.add('oc-keyboard-open', 'oc-kb-animating', 'oc-kb-caret-hold');
        setInset(keyboardHeight);
        for (const { el, factor } of getKbMovers()) {
            el.style.transition = `transform ${KB_ANIM_MS}ms ${KB_ANIM_EASING}`;
            el.style.transform = `translateY(${-slide * factor}px)`;
        }
        // Reserve the keyboard strip inside the chat scroller NOW and re-pin
        // immediately (settled = one cheap scrollTop write over already-mounted
        // rows), so the chat bottom moves as the keyboard STARTS rising instead
        // of waiting for it to finish. `slide` (keyboard minus the safe inset
        // the shell gives up) is exactly the strip the scroller loses at
        // settle, so pin position and settle stay geometry-neutral.
        setVar('--oc-kb-scroll-inset', slide);
        dispatchKb('oc:keyboard-settled', { open: true });
        dispatchKb('oc:keyboard-anim', { phase: 'show', slide, durationMs: KB_ANIM_MS, easing: KB_ANIM_EASING });
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          // Invisible swap: transition off, layout takes the keyboard height (one
          // reflow), shift returns to 0 in the same frame.
          root.classList.remove('oc-kb-animating');
          setVar('--oc-kb-layout', keyboardHeight);
          layoutApplied = true;
          clearKbMovers();
          dispatchKb('oc:keyboard-settled', { open: true });
          // Reveal the caret only after UIKit's own caret reposition window.
          caretTimer = window.setTimeout(() => {
            caretTimer = null;
            root.classList.remove('oc-kb-caret-hold');
          }, 250);
        }, KB_ANIM_MS + 20);
      });

      // Shared hide choreography. The bridge's `keyboardWillHide` can arrive a
      // beat AFTER the native dismiss animation has already started (WKWebView +
      // resize: 'none'), which made the composer begin its down-slide only once
      // the keyboard was gone. The earliest reliable signal for the common
      // dismissal path (tap outside the input) is the textarea's focusout — so
      // both trigger this, and `keyboardOpen` makes the second call a no-op.
      const runHide = () => {
        if (!keyboardOpen) return;
        keyboardOpen = false;
        clearSettle();
        // Fired BEFORE any layout change: lets the composer collapse into its
        // pill synchronously (flushSync in ChatInput), so the keyboard hide
        // compensation below measures keyboard + composer shrink as ONE delta
        // instead of two staggered steps.
        dispatchKb('oc:keyboard-intent', { open: false });
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.remove('oc-kb-caret-hold');
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('oc-keyboard-open');
        setInset(0);
        setVar('--oc-kb-scroll-inset', 0);
        if (layoutApplied) {
          // Settled-open → restore the full-height layout NOW (still hidden behind
          // the keyboard) and FLIP the movers to their raised position without
          // transitioning, so the next frame looks unchanged.
          root.classList.remove('oc-kb-animating');
          setVar('--oc-kb-layout', 0);
          layoutApplied = false;
          for (const { el, factor } of getKbMovers()) {
            el.style.transition = 'none';
            el.style.transform = `translateY(${-slide * factor}px)`;
          }
          // Force the style/layout flush so the transition below starts from the
          // FLIP position instead of coalescing both writes into one frame.
          void (document.querySelector('.oc-mobile-app-shell') as HTMLElement | null)?.offsetHeight;
        }
        // If the hide interrupted a show mid-animation (layout not applied yet),
        // the movers transition back down from wherever they currently are.
        dispatchKb('oc:keyboard-anim', { phase: 'hide', slide, durationMs: KB_HIDE_MS, easing: KB_ANIM_EASING });
        root.classList.add('oc-kb-animating', 'oc-kb-hide');
        for (const { el } of getKbMovers()) {
            el.style.transition = `transform ${KB_HIDE_MS}ms ${KB_ANIM_EASING}`;
            el.style.transform = 'translateY(0px)';
        }
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          root.classList.remove('oc-kb-animating', 'oc-kb-hide');
          clearKbMovers();
          dispatchKb('oc:keyboard-settled', { open: false });
        }, KB_HIDE_MS + 20);
      };

      const hideHandle = await Keyboard.addListener('keyboardWillHide', runHide);

      // Early hide trigger: blurring the focused text field is what starts the
      // native dismiss animation, and it happens in-page — no bridge latency.
      // Deferred a task so a synchronous refocus (focus moving to another text
      // input, or a control that restores focus) doesn't false-trigger; in that
      // case the keyboard never hides and `keyboardWillHide` never fires either.
      const isTextInput = (node: unknown): boolean =>
        node instanceof HTMLElement
        && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable);
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

      if (disposed) {
        clearSettle();
        document.removeEventListener('focusout', handleFocusOut, true);
        void showHandle.remove();
        void hideHandle.remove();
        return;
      }
      cleanup.push(
        clearSettle,
        () => {
          if (caretTimer !== null) {
            window.clearTimeout(caretTimer);
            caretTimer = null;
          }
        },
        () => document.removeEventListener('focusout', handleFocusOut, true),
        () => void showHandle.remove(),
        () => void hideHandle.remove(),
      );
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
      root.classList.remove('oc-capacitor-app', 'oc-keyboard-open', 'oc-kb-animating', 'oc-kb-hide', 'oc-kb-caret-hold', 'oc-platform-android');
      root.style.removeProperty('--oc-keyboard-inset');
      root.style.removeProperty('--oc-kb-shift');
      root.style.removeProperty('--oc-kb-layout');
      root.style.removeProperty('--oc-kb-scroll-inset');
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

    // Belt-and-suspenders resume detection. Capacitor's `appStateChange` is the
    // primary signal, but on iOS it can be missed after a long suspend, so the
    // webview's own `visibilitychange` is a second trigger — either one flips
    // wasInactiveRef and fires onResume exactly once per background→foreground.
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

export const useNativeAndroidBackButton = (onBack: () => boolean): void => {
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
