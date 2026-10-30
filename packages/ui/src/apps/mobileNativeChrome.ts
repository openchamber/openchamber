import { registerPlugin } from '@capacitor/core';
import React from 'react';

import { observeNativeKeyboardHeight, resetHardwareKeyboardDetection, startHardwareKeyboardBridge } from '@/lib/hardwareKeyboard';
import { KEYBOARD_EASING_CSS, KEYBOARD_HIDE_MS, KEYBOARD_SHOW_MS, keyboardKeyframes } from '@/lib/mobileKeyboardTiming';
import { writeMobileKeyboardVar } from '@/lib/mobileKeyboardInsets';

/** True when running inside the native Capacitor shell (iOS/Android app). */
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

/**
 * Android only (WindowLayoutPlugin.java). The OS version comes from native code because
 * hardened WebViews (GrapheneOS's Vanadium) report "Android 10" in the user agent on
 * every release.
 */
const WindowLayout = registerPlugin<WindowLayoutPlugin>('WindowLayout');

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

    // iOS reports hardware keyboards natively (GCKeyboard); adopting that
    // answer switches the layout off its keyboard-event inference entirely.
    cleanup.push(startHardwareKeyboardBridge());

    const setInset = (px: number) => {
      writeMobileKeyboardVar('--oc-keyboard-inset', px);
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
          const overlayOff = await StatusBar.setOverlaysWebView({ overlay: false }).then(() => true, () => false);
          // Before Android 15 that call moves the WebView below the status bar natively, so
          // the page must not reserve the strip again. Marked only once the call succeeded:
          // until then the WebView still sits under the bar and needs the injected inset.
          const edgeToEdge = await WindowLayout.get().then(({ edgeToEdge }) => edgeToEdge, () => true);
          if (overlayOff && !edgeToEdge) {
            root.classList.add('oc-android-below-status-bar');
          }
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

      // Theme toggles must reach the status bar without an app restart: re-run
      // whenever the root dark/light class flips — the one signal every theme
      // path converges on (settings toggle, synced settings, storage events,
      // system-preference changes while in system mode). splashBg* colors are
      // per-variant values, so they are stable across mode toggles.
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
        const willShowHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
          observeNativeKeyboardHeight(info.keyboardHeight);
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
      // Durations and curve are shared with the composer morph and the
      // transcript's follow glide (mobileKeyboardTiming.ts).
      const KB_ANIM_MS = KEYBOARD_SHOW_MS;
      const KB_HIDE_MS = KEYBOARD_HIDE_MS;
      const KB_ANIM_EASING = KEYBOARD_EASING_CSS;
      let settleTimer: number | null = null;
      let caretTimer: number | null = null;
      let keyboardHeight = 0;
      let layoutApplied = false;
      let safeBottomPx = 0;
      let keyboardOpen = false;
      // Whether the field the keyboard opened for is in the app shell (the
      // composer, the transcript) or on a surface over it; the hide reports
      // the same, since by then the field has lost focus.
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
      // Elements that ride the keyboard slide, with their travel factor. Driven
      // by INLINE styles from here: WebKit does not reliably start a transition
      // when the transform's value changes via a CSS custom property, which
      // left the composer parked until the keyboard finished.
      // `travel` is how far a mover goes: the shell's movers by the strip
      // the shell gives up (the keyboard less its bottom safe padding), a
      // keyboard rider by the keyboard itself, each times its factor.
      type KbMover = { el: HTMLElement; factor: number; base: 'shell' | 'keyboard' };
      const getKbMovers = (): KbMover[] => {
        const movers: KbMover[] = [];
        const composer = keyboardInShell ? document.querySelector<HTMLElement>('.oc-mobile-composer') : null;
        if (composer) movers.push({ el: composer, factor: 1, base: 'shell' });
        // Status row, recap hint and scroll-to-end button sit on the slot's
        // top edge outside the form; they ride the same slide.
        const riders = keyboardInShell ? document.querySelector<HTMLElement>('.oc-composer-riders') : null;
        if (riders) movers.push({ el: riders, factor: 1, base: 'shell' });
        // The centered draft title moves half the shift — exactly where the
        // center lands after the shell snap (see mobile.css notes).
        const draftCenter = keyboardInShell ? document.querySelector<HTMLElement>('.oc-draft-center') : null;
        if (draftCenter) movers.push({ el: draftCenter, factor: 0.5, base: 'shell' });
        // What sits at the bottom of a layout that takes the keyboard in when
        // the change is invisible (--oc-kb-layout): a drawer's footer, a
        // comment field, the terminal's key row, a dialog's card at half the
        // travel. These ride the keyboard meanwhile, by the shell's strip
        // inside the shell (the iPad's panels) and the keyboard's own height
        // in a surface over it.
        for (const el of document.querySelectorAll<HTMLElement>('[data-keyboard-rider]')) {
          const inShell = el.closest('.oc-mobile-app-shell') !== null;
          // The shell keeps its layout for a keyboard opened over it.
          if (inShell && !keyboardInShell) continue;
          movers.push({ el, factor: Number(el.dataset.keyboardRider) || 1, base: inShell ? 'shell' : 'keyboard' });
        }
        return movers;
      };
      const travel = (mover: KbMover, slide: number) => (mover.base === 'shell' ? slide : keyboardHeight) * mover.factor;
      // The movers slide as Web Animations on keyframes of the keyboard's
      // curve, which Core Animation runs at the screen's rate whatever the
      // main thread is doing (a CSS transition on a `linear()` easing ran on
      // the main thread instead). The inline transform holds where a slide
      // ends; the animation covers the way there.
      const moverAnimations = new WeakMap<HTMLElement, Animation>();
      const moverShift = (el: HTMLElement): number => {
        const transform = getComputedStyle(el).transform;
        return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
      };
      const slideMovers = (durationMs: number, from: (mover: KbMover) => number, to: (mover: KbMover) => number) => {
        const movers = getKbMovers();
        // Read every start before writing, so the reads cost one style pass.
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
        clearSettle();
        dropRevealRoom();
        observeNativeKeyboardHeight(info.keyboardHeight);
        const inShell = document.activeElement?.closest('.oc-mobile-app-shell') != null;
        // Focus moved between the shell and a surface over it with the
        // keyboard up: the shell gives back what it took for the old field,
        // its movers first (they are found under the old owner).
        if (keyboardOpen && keyboardInShell && !inShell) {
          clearKbMovers();
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-scroll-inset', 0);
        }
        keyboardOpen = true;
        keyboardHeight = info.keyboardHeight;
        keyboardInShell = inShell;
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
        slideMovers(KB_ANIM_MS, (mover) => moverShift(mover.el), (mover) => -travel(mover, slide));
        // Reserve the keyboard strip inside the chat scroller NOW, in one
        // write: the transcript's geometry is final from the first frame and
        // the chat's follow glide (keyboardFollowGlide, started by the anim
        // event below) moves scrollTop to the new end on the keyboard curve.
        // `slide` (keyboard minus the safe inset the shell gives up) is exactly
        // the strip the scroller loses at settle, so the glide's destination
        // and the settle snap stay geometry-neutral.
        // A keyboard for a field over the shell (a drawer's, a dialog's)
        // leaves the shell as it is: it is covered, and a transcript that
        // follows its end would chase every change of it.
        if (keyboardInShell) setVar('--oc-kb-scroll-inset', slide);
        dispatchKb('oc:keyboard-anim', { phase: 'show', slide, durationMs: KB_ANIM_MS, easing: KB_ANIM_EASING, inShell: keyboardInShell });
        revealFocusedField('start');
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          // Invisible swap: transition off, layout takes the keyboard height (one
          // reflow), shift returns to 0 in the same frame.
          root.classList.remove('oc-kb-animating');
          setVar('--oc-kb-surface', keyboardHeight);
          if (keyboardInShell) setVar('--oc-kb-layout', keyboardHeight);
          layoutApplied = true;
          clearKbMovers();
          dispatchKb('oc:keyboard-settled', { open: true });
          revealFocusedField('landed');
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
        dropRevealRoom();
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
        // The scroller keeps its keyboard padding until the keyboard has
        // landed: the follow glide moves scrollTop down to where the end will
        // be, and the settle write below then only clamps it to the value it
        // already has. Releasing the padding here would drop the transcript
        // at frame 0 while the composer was still sliding.
        const wasSettledOpen = layoutApplied;
        if (layoutApplied) {
          // Settled-open → restore the full-height layout NOW (still hidden behind
          // the keyboard); the movers start from their raised position below, so
          // the next frame looks unchanged.
          root.classList.remove('oc-kb-animating');
          setVar('--oc-kb-layout', 0);
          setVar('--oc-kb-surface', 0);
          layoutApplied = false;
        }
        dispatchKb('oc:keyboard-anim', { phase: 'hide', slide, durationMs: KB_HIDE_MS, easing: KB_ANIM_EASING, inShell: keyboardInShell });
        root.classList.add('oc-kb-animating', 'oc-kb-hide');
        // Settled open, the movers start from their raised position (the
        // layout just dropped under them); a hide that interrupts a show
        // starts them from wherever they are.
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

      // Early hide trigger: blurring the focused text field is what starts the
      // native dismiss animation, and it happens in-page — no bridge latency.
      // Deferred a task so a synchronous refocus (focus moving to another text
      // input, or a control that restores focus) doesn't false-trigger; in that
      // case the keyboard never hides and `keyboardWillHide` never fires either.
      const isTextInput = (node: unknown): boolean =>
        node instanceof HTMLElement
        && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable);
      // A focused field the keyboard will cover (low in a page or a list)
      // scrolls up into the space above it, within its own scroller. The
      // WebView does not do it: with `resize: 'none'` the field is not hidden
      // as far as it knows. It starts with the keyboard, where the native
      // smooth scroll runs beside its rise; a field that moves on its own
      // (the composer, a rider, an overlay's sheet, the transcript, which
      // glides) waits for the keyboard to land. A list that cannot scroll
      // that far yet (the field near its end, its surface not yet shorter)
      // gets the missing room as bottom padding, kept while the keyboard is
      // up: dropped at the landing, the list would settle back by the margin
      // the field keeps above the keyboard. At the landing every field is
      // checked again.
      let revealRoom: { scroller: HTMLElement; padding: string } | null = null;
      function dropRevealRoom() {
        if (!revealRoom) return;
        revealRoom.scroller.style.paddingBottom = revealRoom.padding;
        revealRoom = null;
      }
      function revealFocusedField(phase: 'start' | 'landed') {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !isTextInput(field)) return;
        // A terminal takes keys through a hidden field and keeps its own
        // view; room added under it squeezed its canvas. Any other field
        // nobody sees is someone else's input proxy too.
        if (field.closest('[data-terminal-owner]')) return;
        const box = field.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || getComputedStyle(field).opacity === '0') return;
        if (phase === 'start' && field.closest('.oc-mobile-composer, [data-keyboard-rider], .oc-keyboard-inset-snap, .chat-scroll')) return;
        // An editable region (CodeMirror's content is the whole document) is
        // measured at its caret; one whose caret cannot be measured is left
        // alone.
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
          // The nearest scroller, whether or not it overflows yet: a short
          // list only does once its surface is shorter.
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const missing = overlap - (node.scrollHeight - node.clientHeight - node.scrollTop);
            if (phase === 'start' && missing > 0) {
              const fieldBottom = field.getBoundingClientRect().bottom;
              revealRoom = { scroller: node, padding: node.style.paddingBottom };
              node.style.paddingBottom = `${(Number.parseFloat(style.paddingBottom) || 0) + missing}px`;
              // A field the room moved is held to the bottom of its layout,
              // not listed in it: it rises with its surface when the
              // keyboard lands (better, it is marked as a rider), and the
              // room would only lift it twice.
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

      if (disposed) {
        clearSettle();
        document.removeEventListener('focusout', handleFocusOut, true);
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
