import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { McpIcon } from '@/components/icons/McpIcon';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { Button } from '@/components/ui/button';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ChatView } from '@/components/views/ChatView';
import { SettingsView } from '@/components/views/SettingsView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useRouter } from '@/hooks/useRouter';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { ProjectEntry, RuntimeAPIs } from '@/lib/api/types';
import { useOrientation } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isIPadApp } from '@/lib/platform';
import { normalizeProjectPath, resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { clampPercent, formatQuotaResetLabel, formatQuotaValueLabel, formatWindowLabel, QUOTA_PROVIDERS, resolveUsageTone } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import type { QuotaProviderId, UsageWindow } from '@/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider, useSession, useSessionMessages } from '@/sync/sync-context';

import { SyncAppEffects } from './AppEffects';
import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobileSurfaceShell } from './MobileSurfaceShell';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { autoConnectLastInstance, connectionDisplayUrl, isActiveRuntimeConnection, reprobeActiveConnection, useMobileConnection } from './mobileConnections';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { isQrScanSupported, parseConnectionPayload, scanConnectionQr } from './mobileQrScan';
import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkHandlers, useDeepLinkSource } from './deepLinkNavigation';
import { useEdgeSwipeSessionSwitch } from './useEdgeSwipeSessionSwitch';
import { useNativePushRegistration } from './useNativePushRegistration';

const MOBILE_SETTINGS_PAGES = [
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'git',
  'magic-prompts',
  'behavior',
  'mcp',
  'providers',
  'usage',
  'voice',
  'about',
] as const;

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const IPAD_LEFT_SIDEBAR_WIDTH = 320;
const IPAD_RIGHT_SIDEBAR_WIDTH = 380;
const IPAD_SIDEBAR_MIN_WIDTH = 280;
const IPAD_SIDEBAR_MAX_WIDTH = 560;
const IPAD_METADATA_POPOVER_WIDTH = 380;

/** Drag-resize for the iPad sidebars: same live-width mechanics as the desktop
    Sidebar (imperative styles during the drag, committed to state at the end),
    but with a finger-sized grab strip instead of a 3px hover handle. */
function useIpadSidebarResize(side: 'left' | 'right', storageKey: string, defaultWidth: number) {
  const asideRef = React.useRef<HTMLElement | null>(null);
  const [width, setWidth] = React.useState(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
    if (!Number.isFinite(stored)) return defaultWidth;
    return Math.min(IPAD_SIDEBAR_MAX_WIDTH, Math.max(IPAD_SIDEBAR_MIN_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIdRef = React.useRef<number | null>(null);

  const clampWidth = React.useCallback((value: number) => (
    Math.min(IPAD_SIDEBAR_MAX_WIDTH, Math.max(IPAD_SIDEBAR_MIN_WIDTH, Math.round(value)))
  ), []);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const aside = asideRef.current;
    if (!aside) return;
    aside.style.width = `${nextWidth}px`;
    aside.style.minWidth = `${nextWidth}px`;
    aside.style.maxWidth = `${nextWidth}px`;
    aside.style.setProperty('--oc-ipad-sidebar-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    setIsResizing(true);
    event.preventDefault();
  }, [width]);

  const handlePointerMove = React.useCallback((event: React.PointerEvent) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const delta = event.clientX - startXRef.current;
    const next = clampWidth(startWidthRef.current + (side === 'left' ? delta : -delta));
    if (liveWidthRef.current === next) return;
    liveWidthRef.current = next;
    applyLiveWidth(next);
  }, [applyLiveWidth, clampWidth, side]);

  const handlePointerEnd = React.useCallback((event: React.PointerEvent) => {
    if (pointerIdRef.current !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampWidth(liveWidthRef.current ?? startWidthRef.current);
    pointerIdRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
    try {
      window.localStorage.setItem(storageKey, String(finalWidth));
    } catch {
      // ignore
    }
  }, [clampWidth, storageKey]);

  const handleProps = React.useMemo(() => ({
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerEnd,
    onPointerCancel: handlePointerEnd,
  }), [handlePointerDown, handlePointerEnd, handlePointerMove]);

  return { asideRef, width, isResizing, handleProps };
}

const IpadSidebarResizeHandle: React.FC<{
  side: 'left' | 'right';
  isResizing: boolean;
  ariaLabel: string;
  handleProps: React.HTMLAttributes<HTMLDivElement>;
}> = ({ side, isResizing, ariaLabel, handleProps }) => (
  <div
    className={cn(
      'absolute inset-y-0 z-30 w-6 cursor-col-resize touch-none',
      side === 'left' ? 'right-0' : 'left-0',
    )}
    role="separator"
    aria-orientation="vertical"
    aria-label={ariaLabel}
    {...handleProps}
  >
    <div
      className={cn(
        'absolute inset-y-0 w-[3px] transition-colors',
        side === 'left' ? 'right-0' : 'left-0',
        isResizing && 'bg-[var(--interactive-border)]',
      )}
    />
  </div>
);

const isCapacitorMobileApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  const maybeCapacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  if (maybeCapacitor?.isNativePlatform?.() === true) return true;
  return window.location.protocol === 'capacitor:';
};

const useNativeMobileChrome = (): void => {
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

const useNativeMobileLifecycle = (onResume: () => void): void => {
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

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getNumericLimit = (limit: unknown, key: 'context' | 'output'): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const getTokenCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

const NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1_000;

const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
};

type OverflowItem = {
  key: 'files' | 'changes' | 'mcp' | 'instances' | 'update' | 'settings';
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  badge?: number;
  onSelect: () => void;
};

type ContextDisplay = {
  percentage: number;
  tokens: string;
  colorClass: string;
} | null;

const getProjectDisplayLabel = (project: ProjectEntry | null, fallbackDirectory: string): string => {
  if (project) return project.label?.trim() || getProjectLabel(project.path);
  return getProjectLabel(fallbackDirectory);
};

const MobileConnectionWelcome: React.FC<{ onConnected: () => void }> = ({ onConnected }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnected);
  const { connections, isBusy, isPasswordBusy, error, pendingConnection } = conn;
  const [serverUrl, setServerUrl] = React.useState('');
  const [connectionName, setConnectionName] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // QR pairing is the primary flow; the manual URL form stays collapsed unless
  // scanning is unavailable (web build) or the user asks for it.
  const [manualOpen, setManualOpen] = React.useState(() => !isQrScanSupported());
  // Which saved connection is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.connect({ url: serverUrl, clientToken, label: connectionName });
  }, [clientToken, conn, connectionName, serverUrl]);

  // Accept a pasted pairing link (openchamber://connect?...) in the URL field and
  // split it back into the server URL + token.
  const handleUrlChange = React.useCallback((value: string) => {
    if (/^openchamber:\/\//i.test(value.trim())) {
      const payload = parseConnectionPayload(value);
      if (payload) {
        if ('pairing' in payload) {
          void conn.redeemPairingConnection(payload.pairing);
          return;
        }
        setServerUrl(payload.url);
        if (payload.label) setConnectionName(payload.label);
        if (payload.clientToken) setClientToken(payload.clientToken);
        return;
      }
    }
    setServerUrl(value);
  }, [conn]);

  const handleScanQr = React.useCallback(async () => {
    if (isScanning || isBusy) return;
    conn.setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          setServerUrl(result.url);
          if (result.label) setConnectionName(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          await conn.connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          break;
        case 'pairing':
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          conn.setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          conn.setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          conn.setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          conn.setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsScanning(false);
    }
  }, [conn, isBusy, isScanning, t]);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.submitPassword(password);
  }, [conn, password]);

  const cancelPassword = React.useCallback(() => {
    setPassword('');
    conn.cancelPassword();
  }, [conn]);

  return (
    <main className="oc-keyboard-fill-screen flex min-h-dvh flex-col overflow-y-auto bg-background px-6 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+28px)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+28px)] text-foreground">
      <div className="m-auto flex w-full max-w-[360px] shrink-0 flex-col items-center gap-9 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <OpenChamberLogo width={72} height={72} className="size-[72px]" />
          <h1 className="typography-h2 text-foreground">{t('mobile.connect.welcome.title')}</h1>
        </div>

        {pendingConnection ? (
          <form className="flex w-full flex-col gap-3" onSubmit={handlePasswordSubmit}>
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0 text-left">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={cancelPassword}
            >
              {t('mobile.connect.cancelPassword')}
            </Button>
          </form>
        ) : (
          <div className="flex w-full flex-col gap-6">
            {/* Primary path: scan the pairing QR from "Add a device" on the server. */}
            {qrScanSupported ? (
              <div className="flex w-full flex-col gap-2">
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanQr()}
                  disabled={isScanning || isBusy}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.scanQr')}
                </Button>
                <p className="px-2 text-center typography-small text-muted-foreground">
                  {t('mobile.connect.welcome.scanHint')}
                </p>
              </div>
            ) : null}

            {error && !manualOpen ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}

            {connections.length > 0 ? (
              <section className="flex w-full flex-col gap-2.5">
                <h2 className="text-center typography-micro uppercase tracking-[0.14em] text-muted-foreground">
                  {t('mobile.connect.saved.title')}
                </h2>
                <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
                  {connections.map((connection) => {
                    const isConnectingRow = connectingId === connection.id;
                    return (
                      <button
                        key={connection.id}
                        type="button"
                        disabled={isBusy}
                        className="flex min-h-14 w-full items-center gap-3 border-b border-border/60 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-70"
                        onClick={() => {
                          setConnectingId(connection.id);
                          void conn.connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                            .finally(() => setConnectingId(null));
                        }}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                          <Icon name="server" className="size-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                          <span className={cn('block truncate typography-small', isConnectingRow ? 'text-foreground' : 'text-muted-foreground')}>
                            {isConnectingRow
                              ? t('mobile.connect.connecting')
                              : connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : t('mobile.connect.relay.badge')}
                          </span>
                        </span>
                        {isConnectingRow
                          ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
                          : <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Manual URL entry, collapsed by default — most people pair by QR. */}
            <div className="flex w-full flex-col">
              {qrScanSupported ? (
                <button
                  type="button"
                  onClick={() => setManualOpen((value) => !value)}
                  aria-expanded={manualOpen}
                  className="mx-auto flex items-center gap-1 rounded-full px-2 py-1 typography-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>{t('mobile.connect.manual.toggle')}</span>
                  <Icon name="arrow-down-s" className={cn('size-4 transition-transform duration-200', manualOpen && 'rotate-180')} />
                </button>
              ) : null}
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: manualOpen ? '1fr' : '0fr' }}
              >
                <div className="min-h-0 overflow-hidden">
                  <form className="flex w-full flex-col gap-3 pt-3" onSubmit={handleSubmit}>
                    <input
                      {...mobileInputKeyboardProps}
                      value={serverUrl}
                      onChange={(event) => handleUrlChange(event.target.value)}
                      placeholder={t('mobile.connect.url.placeholder')}
                      aria-label={t('mobile.connect.url.label')}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      tabIndex={manualOpen ? undefined : -1}
                      className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      value={connectionName}
                      onChange={(event) => setConnectionName(event.target.value)}
                      placeholder={t('mobile.instances.label.placeholder')}
                      aria-label={t('mobile.instances.label.label')}
                      autoComplete="off"
                      autoCapitalize="words"
                      autoCorrect="off"
                      spellCheck={false}
                      tabIndex={manualOpen ? undefined : -1}
                      className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      {...mobileInputKeyboardProps}
                      value={clientToken}
                      onChange={(event) => setClientToken(event.target.value)}
                      placeholder={t('mobile.connect.token.placeholder')}
                      aria-label={t('mobile.connect.token.label')}
                      tabIndex={manualOpen ? undefined : -1}
                      autoCapitalize="none"
                      className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <p className="px-1 text-center typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
                    {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
                    <Button type="submit" variant={qrScanSupported ? 'outline' : 'default'} size="lg" className="h-12 w-full" disabled={isBusy || isScanning || !serverUrl.trim()}>
                      {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};

const MobileInstancesSurface: React.FC<{
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ onActiveConnectionDeleted, onConnect }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnect);
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    connect, submitPassword, cancelPassword, saveConnection, removeConnection, setError,
  } = conn;
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingConnection = editingId ? connections.find((connection) => connection.id === editingId) ?? null : null;
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // The manual add/edit form is hidden until asked for — the sheet leads with
  // the list of instances (with live status), not a wall of inputs.
  const [formOpen, setFormOpen] = React.useState(false);
  // Which row is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);

  // Populate/clear the form imperatively (on edit tap / cancel / save) rather than via
  // an effect keyed on the derived connection object. With an effect, any churn of the
  // connections list re-fires it and overwrites what the user is typing — the keyboard
  // "resets" mid-edit. Imperative population is immune to that.
  const resetForm = React.useCallback(() => {
    setEditingId(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setError(null);
    setFormOpen(false);
  }, [setError]);

  const saveInstance = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void saveConnection({ url, label, clientToken }).then((saved) => {
      if (saved) resetForm();
    });
  }, [clientToken, label, resetForm, saveConnection, url]);

  // Scan a pairing QR into the add/edit form fields (does not change edit mode, so
  // the form-reset effect doesn't wipe the scanned values). The user reviews + saves.
  const handleScanInstance = React.useCallback(async () => {
    if (isScanning) return;
    setError(null);
    setIsScanning(true);
    try {
      const result = await scanConnectionQr();
      switch (result.status) {
        case 'ok':
          // Legacy token QR: prefill the manual form for review before saving.
          setUrl(result.url);
          if (result.label) setLabel(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          setFormOpen(true);
          break;
        case 'pairing':
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsScanning(false);
    }
  }, [conn, isScanning, setError, t]);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void submitPassword(password);
  }, [password, submitPassword]);

  const cancelPasswordPrompt = React.useCallback(() => {
    setPassword('');
    cancelPassword();
  }, [cancelPassword]);

  // Two-step delete (mirrors the session sheet): the trash icon arms the row, a
  // second tap on the destructive button confirms, the X disarms. No hover relied on.
  const toggleConfirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId((current) => (current === id ? null : id));
  }, []);

  const confirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId(null);
    if (editingId === id) resetForm();
    // Removing the ACTIVE instance — or the LAST one — must drop the user back
    // to the connect screen instead of leaving them in a stale, unbacked UI.
    const wasLast = connections.length === 1;
    void removeConnection(id).then((removed) => {
      if (!removed) return;
      if (wasLast || isActiveRuntimeConnection(removed)) {
        onActiveConnectionDeleted();
      }
    });
  }, [connections.length, editingId, onActiveConnectionDeleted, removeConnection, resetForm]);

  const inputClass = 'h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20';

  if (pendingConnection) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <form className="flex-1 overflow-y-auto px-5 py-4" onSubmit={handlePasswordSubmit}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className={inputClass}
            />
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={cancelPasswordPrompt}>
              {t('mobile.connect.cancelPassword')}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-6">
          {connections.length > 0 ? (
            <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
              {connections.map((connection) => {
                const confirming = confirmingDeleteId === connection.id;
                const isActive = isActiveRuntimeConnection(connection);
                const isConnectingRow = connectingId === connection.id;
                // Status line: the active instance says HOW it is connected right
                // now (direct vs relay); others show their address.
                const statusText = isConnectingRow
                  ? t('mobile.connect.connecting')
                  : isActive
                    ? (isRelayModeActive() ? t('mobile.instances.status.connectedRelay') : t('mobile.instances.status.connectedDirect'))
                    : connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : t('mobile.connect.relay.badge');
                return (
                  <div
                    key={connection.id}
                    className={cn(
                      'flex items-center border-b border-border/60 transition-colors last:border-b-0',
                      confirming && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-60"
                      onClick={() => {
                        if (isActive) return;
                        setConnectingId(connection.id);
                        void connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                          .finally(() => setConnectingId(null));
                      }}
                      disabled={(isBusy && !isConnectingRow) || confirming}
                    >
                      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                        <Icon name="server" className="size-[18px]" />
                        {isActive ? (
                          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-[var(--surface-elevated)] bg-[var(--status-success)]" aria-hidden />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                        <span className={cn(
                          'block truncate typography-small',
                          isActive && !isConnectingRow ? 'text-[var(--status-success)]' : 'text-muted-foreground',
                        )}>
                          {statusText}
                        </span>
                      </span>
                      {isConnectingRow ? <Icon name="loader-4" className="size-5 shrink-0 animate-spin text-muted-foreground" /> : null}
                    </button>
                    <div className="flex items-center gap-0.5 pr-2">
                      {confirming ? (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.confirmDeleteAria', { label: connection.label })}
                          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 text-destructive-foreground transition-opacity active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                          onClick={() => confirmDelete(connection.id)}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="delete-bin" className="size-[18px]" />
                          <span className="typography-ui-label">{t('mobile.instances.delete')}</span>
                        </button>
                      ) : !connection.candidates.some((c) => c.kind === 'direct') ? null : (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.edit')}
                          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => {
                            setEditingId(connection.id);
                            setUrl(connectionDisplayUrl(connection));
                            setLabel(connection.label);
                            setClientToken(connection.clientToken || '');
                            setError(null);
                          }}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="edit" className="size-[18px]" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={confirming
                          ? t('mobile.instances.cancelDeleteAria', { label: connection.label })
                          : t('mobile.instances.deleteAria', { label: connection.label })}
                        className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => toggleConfirmDelete(connection.id)}
                        style={{ touchAction: 'manipulation' }}
                      >
                        <Icon name={confirming ? 'close' : 'delete-bin'} className="size-[18px]" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-[18px] border border-dashed border-border/70 px-4 py-6 text-center typography-small text-muted-foreground">
              {t('mobile.connect.saved.empty')}
            </p>
          )}

          {/* Add actions: QR pairing is the primary path; the manual form stays
              hidden until asked for (or until a row's edit button opens it). */}
          {!formOpen && !editingConnection ? (
            <div className="space-y-2">
              {qrScanSupported ? (
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanInstance()}
                  disabled={isScanning}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {t('mobile.connect.scanQr')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant={qrScanSupported ? 'ghost' : 'outline'}
                size="lg"
                className="h-12 w-full"
                onClick={() => { setError(null); setFormOpen(true); }}
              >
                <Icon name="add" className="size-[18px]" />
                {t('mobile.instances.addManual')}
              </Button>
              {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            </div>
          ) : (
            <form className="space-y-3" onSubmit={saveInstance}>
              <div className="flex h-8 items-center justify-between gap-3 px-1">
                <h3 className="typography-ui-label text-foreground">
                  {editingConnection ? t('mobile.instances.editTitle') : t('mobile.instances.addTitle')}
                </h3>
                <Button type="button" variant="ghost" size="xs" onClick={resetForm}>
                  {t('mobile.instances.cancelEdit')}
                </Button>
              </div>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.url.label')}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t('mobile.connect.url.placeholder')}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.instances.label.label')}</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('mobile.instances.label.placeholder')}
                  autoComplete="off"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.token.label')}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={clientToken}
                  onChange={(event) => setClientToken(event.target.value)}
                  placeholder={t('mobile.connect.token.placeholder')}
                  autoCapitalize="none"
                  className={inputClass}
                />
                <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
              </label>
              {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button type="submit" size="lg" className="mt-1 h-12 w-full">
                {editingConnection ? t('mobile.instances.saveEdit') : t('mobile.instances.saveNew')}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

type MobileUsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
  window: UsageWindow;
};

type MobileUsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  rows: MobileUsageLimitRow[];
  status: string | null;
};

const getWindowValueClass = (window: UsageWindow): string => {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return 'text-foreground';
  if (usedPercent >= 80) return 'text-[var(--status-error)]';
  if (usedPercent >= 50) return 'text-[var(--status-warning)]';
  return 'text-foreground';
};

const ContextProgressIcon: React.FC<{ percentage: number }> = ({ percentage }) => {
  const progressPct = clampPercent(percentage) ?? 0;
  const tone = resolveUsageTone(percentage);
  const progressColor = tone === 'critical'
    ? 'var(--status-error)'
    : tone === 'warn'
      ? 'var(--status-warning)'
      : 'var(--status-success)';
  const size = 18;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="size-[18px] -rotate-90"
      role="progressbar"
      aria-valuenow={Math.round(progressPct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--interactive-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={progressColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progressPct / 100)}
        className="transition-[stroke-dashoffset,stroke] duration-300"
      />
    </svg>
  );
};

const MetadataRow: React.FC<{
  icon?: IconName;
  iconNode?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, iconNode, label, children }) => (
  <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5">
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {iconNode ?? (icon ? <Icon name={icon} className="size-[18px]" /> : null)}
    </span>
    <span className="shrink-0 typography-ui-label text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 truncate text-right typography-ui-label font-medium text-foreground">
      {children}
    </span>
  </div>
);

const SessionMetadataOverlay: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  contextDisplay: ContextDisplay;
  branchLabel: string;
  usageGroups: MobileUsageProviderGroup[];
  usageDisplayMode: 'usage' | 'remaining';
  isUsageLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ open, onClose, anchorRef, contextDisplay, branchLabel, usageGroups, usageDisplayMode, isUsageLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  // iPad: a phone-width sheet stretched across the whole chat column looks
  // broken — render a popover anchored to the metadata button instead.
  const isIPad = React.useMemo(() => isIPadApp(), []);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [ipadAnchorLeft, setIpadAnchorLeft] = React.useState<number | null>(null);

  // The shell has transformed ancestors, so the fixed wrapper's containing
  // block is the chat column, NOT the viewport. Anchor the popover in the
  // wrapper's own coordinate space — viewport-based lefts would double-count
  // the sidebar offset.
  React.useLayoutEffect(() => {
    if (!open || !isIPad || !shouldRender) return;
    const compute = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!anchorRect || !wrapperRect) {
        setIpadAnchorLeft(null);
        return;
      }
      const relativeLeft = anchorRect.left - wrapperRect.left;
      const left = Math.min(
        Math.max(relativeLeft, 8),
        Math.max(8, wrapperRect.width - IPAD_METADATA_POPOVER_WIDTH - 8),
      );
      setIpadAnchorLeft(left);
    };
    compute();
    // Re-anchor if the chat column shifts while the popover is open (sidebar
    // toggle/resize, orientation change) — the header buttons move with it.
    const wrapper = wrapperRef.current;
    if (typeof ResizeObserver === 'undefined' || !wrapper) return;
    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [anchorRef, isIPad, open, shouldRender]);

  const ipadPopover = isIPad && ipadAnchorLeft !== null;

  React.useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsExiting(false);
      return;
    }

    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;

    const closeIfOutside = (event: PointerEvent | WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    document.addEventListener('wheel', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      document.removeEventListener('wheel', closeIfOutside, true);
    };
  }, [anchorRef, onClose, open]);

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('mobile.header.openMetadataAria')}
        className={cn(
          'overflow-y-auto overscroll-contain rounded-[20px] border border-border/40 bg-[var(--surface-elevated)] p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.2)] will-change-transform',
          ipadPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-metadata-out' : 'session-metadata-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(ipadPopover
            ? {
                top: 8,
                left: ipadAnchorLeft ?? 8,
                width: `min(${IPAD_METADATA_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="space-y-1">
          <MetadataRow icon="git-branch" label={t('mobile.header.metadata.branch')}>
            {branchLabel}
          </MetadataRow>
          {contextDisplay ? (
            <MetadataRow
              iconNode={<ContextProgressIcon percentage={contextDisplay.percentage} />}
              label={t('mobile.header.metadata.context')}
            >
              <span className="inline-flex items-baseline gap-1.5 tabular-nums">
                <span className={cn('font-semibold', contextDisplay.colorClass)}>{contextDisplay.percentage.toFixed(1)}%</span>
                <span className="text-muted-foreground">{contextDisplay.tokens}</span>
              </span>
            </MetadataRow>
          ) : null}
          <MobileUsageLimits
            groups={usageGroups}
            displayMode={usageDisplayMode}
            isLoading={isUsageLoading}
            timeFormatPreference={timeFormatPreference}
          />
        </div>
      </div>
      <style>{`
        @keyframes session-metadata-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-metadata-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};

const MobileUsageLimits: React.FC<{
  groups: MobileUsageProviderGroup[];
  displayMode: 'usage' | 'remaining';
  isLoading: boolean;
  timeFormatPreference: TimeFormatPreference;
}> = ({ groups, displayMode, isLoading, timeFormatPreference }) => {
  const { t } = useI18n();
  const modeLabel = displayMode === 'remaining' ? t('header.services.remaining') : t('header.services.used');

  if (groups.length === 0) return null;

  return (
    <div className="pt-2.5">
      <div className="flex min-w-0 items-center gap-3 px-2.5 pb-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon name="timer" className="size-[18px]" />
        </span>
        <span className="shrink-0 typography-ui-label text-muted-foreground">
          {t('mobile.header.metadata.usage')}
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center justify-end gap-1.5 typography-ui-label text-muted-foreground">
          {isLoading ? <Icon name="refresh" className="size-3.5 animate-spin" /> : null}
          <span className="truncate">{modeLabel}</span>
        </span>
      </div>

      <div className="space-y-1.5">
        {groups.map((group) => (
          <div key={group.providerId} className="min-w-0 rounded-xl bg-[var(--surface-muted)] p-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderLogo providerId={group.providerId} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground">
                {group.providerName}
              </span>
              {group.status && group.rows.length === 0 ? (
                <span className="shrink-0 truncate typography-micro text-muted-foreground">
                  {group.status}
                </span>
              ) : null}
            </div>
            {group.rows.length > 0 ? (
              <div className="mt-1.5 space-y-1">
                {group.rows.map((row) => {
                  const displayPercent = displayMode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
                  const metricLabel = formatQuotaValueLabel(row.window.valueLabel, displayPercent);
                  const resetLabel = formatQuotaResetLabel(
                    row.window.resetAt,
                    row.window.resetAfterFormatted ?? row.window.resetAtFormatted,
                    timeFormatPreference,
                  );
                  return (
                    <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="inline-flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate typography-ui-label text-muted-foreground">
                          {row.subtitle ? `${row.subtitle} · ${row.label}` : row.label}
                        </span>
                        {resetLabel ? (
                          <span className="shrink-0 truncate typography-micro text-muted-foreground/70">{resetLabel}</span>
                        ) : null}
                      </span>
                      <span className={cn('shrink-0 typography-ui-label font-semibold tabular-nums', getWindowValueClass(row.window))}>
                        {metricLabel === '-' ? '' : metricLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {group.status && group.rows.length > 0 ? (
              <div className="mt-1.5 typography-micro text-muted-foreground">{group.status}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const MobileOverflowMenu: React.FC<{
  open: boolean;
  onClose: () => void;
  items: OverflowItem[];
  /** Extra viewport-right inset so the dropdown stays anchored to the
      three-dots button when the iPad right sidebar shifts the header. */
  rightOffset?: number;
}> = ({ open, onClose, items, rightOffset = 0 }) => {
  const { t } = useI18n();
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t('mobile.menu.titleAria')}>
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={t('mobile.surface.closeAria')}
        onClick={onClose}
      />
      <div
        className="absolute top-[calc(var(--oc-safe-area-top,0px)+56px+4px)] w-[min(220px,calc(100vw-1rem))] origin-top-right overflow-hidden rounded-2xl border border-border/40 bg-background shadow-[0_18px_60px_rgb(0_0_0_/_0.35)]"
        role="menu"
        style={{
          right: `${8 + rightOffset}px`,
          animation: 'mobile-menu-in 160ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
              index > 0 && 'border-t border-border/30',
            )}
            style={{ touchAction: 'manipulation' }}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.iconNode ?? (item.icon ? <Icon name={item.icon} className="size-5 shrink-0 text-muted-foreground" /> : null)}
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{item.label}</span>
            {item.badge && item.badge > 0 ? (
              <span className="inline-flex size-2 shrink-0 rounded-full bg-primary" aria-hidden />
            ) : null}
          </button>
        ))}
      </div>
      <style>{`@keyframes mobile-menu-in { from { opacity: 0; transform: translateY(-6px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }`}</style>
    </div>
  );
};

const MobileSessionMetadataButton = React.memo(function MobileSessionMetadataButton({
  open,
  onOpenChange,
  currentSessionId,
  effectiveDirectory,
  gitDirectory,
  isNewSessionDraftOpen,
  primaryLabel,
  secondaryLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  currentSessionId: string | null;
  effectiveDirectory: string | null;
  gitDirectory: string | null;
  isNewSessionDraftOpen: boolean;
  primaryLabel: string;
  secondaryLabel: string;
}) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const metadataTriggerRef = React.useRef<HTMLButtonElement>(null);
  const activeSessionMessages = useSessionMessages(currentSessionId ?? '', effectiveDirectory || undefined);
  const isGitRepo = useIsGitRepo(gitDirectory);
  const gitStatus = useGitStatus(gitDirectory);
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  useConfigStore((state) => state.modelsMetadata.size);
  const savedSessionModel = useSelectionStore(
    React.useCallback(
      (state) => (currentSessionId ? state.sessionModelSelections.get(currentSessionId) ?? null : null),
      [currentSessionId],
    ),
  );
  const quotaResults = useQuotaStore((state) => state.results);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isQuotaLoading = useQuotaStore((state) => state.isLoading);
  const quotaDisplayMode = useQuotaStore((state) => state.displayMode);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    if (!gitDirectory) return;
    void ensureStatus(gitDirectory, git);
  }, [ensureStatus, git, gitDirectory]);

  React.useEffect(() => {
    if (!gitDirectory) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== gitDirectory) return;
      void fetchStatus(gitDirectory, git);
    });
  }, [fetchStatus, git, gitDirectory]);

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);

  React.useEffect(() => {
    preloadProviderLogos(dropdownProviderIds);
  }, [dropdownProviderIds]);

  React.useEffect(() => {
    if (!open || isQuotaLoading) return;
    const missingEnabledProvider = dropdownProviderIds.some((providerId) => (
      !quotaResults.some((result) => result.providerId === providerId)
    ));
    if (!missingEnabledProvider) return;
    void fetchAllQuotas();
  }, [dropdownProviderIds, fetchAllQuotas, isQuotaLoading, open, quotaResults]);

  const latestMessageModel = React.useMemo(() => {
    for (let i = activeSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = activeSessionMessages[i] as typeof activeSessionMessages[number] & {
        model?: { providerID?: string; modelID?: string };
      };
      if (message.role !== 'user') continue;
      const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined;
      const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined;
      if (providerID && modelID) return { providerID, modelID };
    }
    return null;
  }, [activeSessionMessages]);

  const modelRef = latestMessageModel
    ?? (savedSessionModel ? { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId } : null)
    ?? (currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null);
  const provider = modelRef ? providers.find((entry) => entry.id === modelRef.providerID) : undefined;
  const liveModel = provider?.models.find((model) => model.id === modelRef?.modelID);
  const metadata = modelRef ? getModelMetadata(modelRef.providerID, modelRef.modelID) : undefined;
  const contextLimit = getNumericLimit((liveModel as { limit?: unknown } | undefined)?.limit, 'context')
    ?? metadata?.limit?.context
    ?? 0;
  const totalTokens = React.useMemo(() => {
    for (let i = activeSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = activeSessionMessages[i] as typeof activeSessionMessages[number] & {
        tokens?: {
          input?: unknown;
          output?: unknown;
          reasoning?: unknown;
          cache?: { read?: unknown; write?: unknown };
        };
      };
      if (message.role !== 'assistant' || !message.tokens) continue;
      const total = getTokenCount(message.tokens.input)
        + getTokenCount(message.tokens.output)
        + getTokenCount(message.tokens.reasoning)
        + getTokenCount(message.tokens.cache?.read)
        + getTokenCount(message.tokens.cache?.write);
      if (total > 0) return total;
    }
    return 0;
  }, [activeSessionMessages]);

  const contextPercentage =
    !isNewSessionDraftOpen && totalTokens > 0 && contextLimit > 0
      ? Math.min((totalTokens / contextLimit) * 100, 999)
      : null;
  const contextTokens = contextPercentage !== null
    ? `${formatTokens(totalTokens)}/${formatTokens(contextLimit)}`
    : null;
  const contextColorClass =
    contextPercentage === null
      ? ''
      : contextPercentage >= 90
        ? 'text-[var(--status-error)]'
        : contextPercentage >= 75
          ? 'text-[var(--status-warning)]'
          : 'text-[var(--status-success)]';
  const contextDisplay: ContextDisplay = contextPercentage !== null && contextTokens
    ? { percentage: contextPercentage, tokens: contextTokens, colorClass: contextColorClass }
    : null;

  const branchLabel = isGitRepo === true
    ? (gitStatus?.current?.trim() || t('gitView.branch.detachedHead'))
    : t('common.unavailable');

  const usageGroups = React.useMemo<MobileUsageProviderGroup[]>(() => {
    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
    return QUOTA_PROVIDERS
      .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
      .filter((providerMeta) => resultsByProvider.get(providerMeta.id)?.configured === true)
      .map((providerMeta) => {
        const result = resultsByProvider.get(providerMeta.id)!;
        const rows: MobileUsageLimitRow[] = [];

        for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
          rows.push({
            key: `window-${label}`,
            label: formatWindowLabel(label),
            window,
          });
        }

        const modelEntries = Object.entries(result?.usage?.models ?? {});
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const [label, window] = entries[0];
          rows.push({
            key: `model-${modelName}-${label}`,
            label: formatWindowLabel(label),
            subtitle: getDisplayModelName(modelName),
            window,
          });
        }

        const status = !result.ok && result.error
          ? result.error
          : rows.length === 0
            ? t('header.services.noRateLimitsReported')
            : null;

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          rows,
          status,
        };
      });
  }, [dropdownProviderIds, quotaResults, selectedQuotaModels, t]);

  React.useEffect(() => {
    if (!open || usageGroups.length === 0) return;
    preloadProviderLogos(usageGroups.map((group) => group.providerId));
  }, [open, usageGroups]);

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center px-2 py-1.5 text-left">
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="block truncate typography-ui-label text-foreground">{primaryLabel}</span>
          {secondaryLabel ? (
            <span className="block truncate typography-micro text-muted-foreground">{secondaryLabel}</span>
          ) : null}
        </span>
      </div>
      <button
        ref={metadataTriggerRef}
        type="button"
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={t('mobile.header.openMetadataAria')}
        aria-expanded={open}
        onClick={() => onOpenChange((currentOpen) => !currentOpen)}
        style={{ touchAction: 'manipulation' }}
      >
        <Icon name="apps-2-ai" className="size-5" />
      </button>
      <SessionMetadataOverlay
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={metadataTriggerRef}
        contextDisplay={contextDisplay}
        branchLabel={branchLabel}
        usageGroups={usageGroups}
        usageDisplayMode={quotaDisplayMode}
        isUsageLoading={isQuotaLoading}
        timeFormatPreference={timeFormatPreference}
      />
    </>
  );
});

type MobileHeaderSurfaceShortcuts = {
  activePanel: 'files' | 'changes' | null;
  changesDirty: boolean;
  onToggleFiles: () => void;
  onToggleChanges: () => void;
};

const MobileHeader: React.FC<{
  onOpenSessions: () => void;
  onOpenMenu: () => void;
  /** iPad only: Files/Changes header shortcuts that toggle the right sidebar. */
  surfaceShortcuts?: MobileHeaderSurfaceShortcuts;
}> = ({ onOpenSessions, onOpenMenu, surfaceShortcuts }) => {
  const { t } = useI18n();
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null), [currentSessionId]),
  );
  const effectiveDirectory = currentSessionDirectory || currentDirectory;
  const gitDirectory = normalizePath(effectiveDirectory) || null;
  const projects = useProjectsStore((state) => state.projects);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const currentWorktreeMetadata = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.worktreeMetadata.get(currentSessionId) ?? null : null), [currentSessionId]),
  );
  const currentSession = useSession(currentSessionId, effectiveDirectory || undefined);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));

  const projectLabel = React.useMemo(() => {
    const directory = normalizePath(effectiveDirectory);
    if (!directory) return t('mobile.header.noProject');
    const metadataProject = currentWorktreeMetadata?.projectDirectory
      ? resolveProjectForDirectory(projects, currentWorktreeMetadata.projectDirectory)
      : null;
    const project = metadataProject ?? resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return getProjectDisplayLabel(project, directory) || t('mobile.header.noProject');
  }, [availableWorktreesByProject, currentWorktreeMetadata?.projectDirectory, effectiveDirectory, projects, t]);

  const sessionTitle = currentSession?.title?.trim();
  const primaryLabel = sessionTitle || (currentSessionId ? t('mobile.sessions.untitled') : projectLabel);
  const secondaryLabel = currentSessionId ? projectLabel : '';

  React.useEffect(() => {
    setMetadataOpen(false);
  }, [currentSessionId, effectiveDirectory]);

  const handleOpenSessions = React.useCallback(() => {
    setMetadataOpen(false);
    onOpenSessions();
  }, [onOpenSessions]);

  const handleOpenMenu = React.useCallback(() => {
    setMetadataOpen(false);
    onOpenMenu();
  }, [onOpenMenu]);

  return (
    <>
      <header
        className="oc-mobile-header relative z-30 flex shrink-0 items-center gap-1 border-b border-border/30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
      >
        <div className="flex h-[var(--oc-header-height,56px)] w-full items-center gap-1 px-2">
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.sessions.openSheetAria')}
            onClick={handleOpenSessions}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="folders" className="size-5" />
          </button>

          <MobileSessionMetadataButton
            open={metadataOpen}
            onOpenChange={setMetadataOpen}
            currentSessionId={currentSessionId}
            effectiveDirectory={effectiveDirectory}
            gitDirectory={gitDirectory}
            isNewSessionDraftOpen={isNewSessionDraftOpen}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />

          {surfaceShortcuts ? (
            <>
              <button
                type="button"
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  surfaceShortcuts.activePanel === 'files'
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
                aria-label={t('mobile.menu.files')}
                aria-pressed={surfaceShortcuts.activePanel === 'files'}
                onClick={surfaceShortcuts.onToggleFiles}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="file-text" className="size-5" />
              </button>
              <button
                type="button"
                className={cn(
                  'relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  surfaceShortcuts.activePanel === 'changes'
                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
                aria-label={t('mobile.menu.changes')}
                aria-pressed={surfaceShortcuts.activePanel === 'changes'}
                onClick={surfaceShortcuts.onToggleChanges}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="git-branch" className="size-5" />
                {surfaceShortcuts.changesDirty ? (
                  <span className="absolute right-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
                ) : null}
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.header.openMenuAria')}
            onClick={handleOpenMenu}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="more-2" className="size-5" />
          </button>
        </div>
      </header>
    </>
  );
};

const MobileShell: React.FC<{ onActiveConnectionDeleted: () => void }> = ({ onActiveConnectionDeleted }) => {
  const { t } = useI18n();
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [changesOpen, setChangesOpen] = React.useState(false);
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [instancesOpen, setInstancesOpen] = React.useState(false);
  const [isMcpRefreshing, setIsMcpRefreshing] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [updateOpen, setUpdateOpen] = React.useState(false);
  const [settingsInitialMobileStage, setSettingsInitialMobileStage] = React.useState<'nav' | 'page-content'>('nav');
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  // When set, the Changes surface opens directly into the per-file diff for this path.
  const [pendingChangesDiff, setPendingChangesDiff] = React.useState<{ path: string; staged: boolean } | null>(null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const updateAvailable = useUpdateStore((state) => state.available);
  const updateRuntimeType = useUpdateStore((state) => state.runtimeType);
  const showCapacitorOnlyFeatures = React.useMemo(() => isCapacitorMobileApp(), []);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const setMcpDraft = useMcpConfigStore((state) => state.setMcpDraft);
  const setSelectedMcp = useMcpConfigStore((state) => state.setSelectedMcp);
  const refreshMcpStatus = useMcpStore((state) => state.refresh);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const gitStatus = useGitStatus(normalizePath(currentDirectory) || null);
  const dirtyChangeCount = gitStatus?.files?.length ?? 0;

  // iPad (Capacitor): sessions live in a persistent full-height left sidebar
  // and Changes/Files in a right sidebar, instead of phone sheets/surfaces.
  const isIPad = React.useMemo(() => isIPadApp(), []);
  const orientation = useOrientation();
  const isPortrait = orientation === 'portrait';
  const [ipadSidebarOpen, setIpadSidebarOpen] = React.useState(isIPad && !isPortrait);
  const [ipadRightPanel, setIpadRightPanel] = React.useState<'files' | 'changes' | null>(null);

  const toggleIpadSidebar = React.useCallback(() => {
    const willOpen = !ipadSidebarOpen;
    // Portrait doesn't fit both side panels next to a usable chat column:
    // opening one closes the other (iPadOS behaves the same way).
    if (willOpen && isPortrait) setIpadRightPanel(null);
    setIpadSidebarOpen(willOpen);
  }, [ipadSidebarOpen, isPortrait]);

  const openFilesSurface = React.useCallback(() => {
    if (isIPad) {
      setPendingChangesDiff(null);
      setIpadRightPanel('files');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setFilesOpen(true);
  }, [isIPad, isPortrait]);

  const openChangesSurface = React.useCallback((diff: { path: string; staged: boolean } | null = null) => {
    setPendingChangesDiff(diff);
    if (isIPad) {
      setIpadRightPanel('changes');
      if (isPortrait) setIpadSidebarOpen(false);
      return;
    }
    setChangesOpen(true);
  }, [isIPad, isPortrait]);

  const closeIpadRightPanel = React.useCallback(() => {
    setIpadRightPanel(null);
    setPendingChangesDiff(null);
  }, []);

  const toggleIpadRightPanel = React.useCallback((panel: 'files' | 'changes') => {
    if (ipadRightPanel === panel) {
      closeIpadRightPanel();
      return;
    }
    if (panel === 'files') openFilesSurface();
    else openChangesSurface();
  }, [closeIpadRightPanel, ipadRightPanel, openChangesSurface, openFilesSurface]);

  // Keep the right panel's content mounted through the width-collapse
  // animation; drop it once the panel is fully closed.
  const lastIpadRightPanelRef = React.useRef<'files' | 'changes'>('changes');
  if (ipadRightPanel) lastIpadRightPanelRef.current = ipadRightPanel;
  const [ipadRightContentMounted, setIpadRightContentMounted] = React.useState(false);
  React.useEffect(() => {
    if (!isIPad) return;
    if (ipadRightPanel) {
      setIpadRightContentMounted(true);
      return;
    }
    const id = window.setTimeout(() => setIpadRightContentMounted(false), 240);
    return () => window.clearTimeout(id);
  }, [ipadRightPanel, isIPad]);
  const renderedIpadRightPanel = ipadRightPanel ?? lastIpadRightPanelRef.current;

  const leftResize = useIpadSidebarResize('left', 'openchamber.ipad.leftSidebarWidth', IPAD_LEFT_SIDEBAR_WIDTH);
  const rightResize = useIpadSidebarResize('right', 'openchamber.ipad.rightSidebarWidth', IPAD_RIGHT_SIDEBAR_WIDTH);

  const mobileActions = React.useMemo<MobileAppActions>(
    () => ({
      openChanges: ({ diffPath, staged } = {}) => {
        openChangesSurface(diffPath ? { path: diffPath, staged: staged === true } : null);
      },
      openFiles: () => openFilesSurface(),
      openSettings: () => {
        setSettingsInitialMobileStage('nav');
        setSettingsOpen(true);
      },
    }),
    [openChangesSurface, openFilesSurface],
  );

  const closeChanges = React.useCallback(() => {
    setChangesOpen(false);
    setPendingChangesDiff(null);
  }, []);

  // Expose the shell's panel-opening actions to the deep-link layer so openchamber:// URLs
  // (and notification taps / widgets) can navigate to these surfaces. Session and
  // new-session intents resolve directly against the store, so they aren't wired here.
  const deepLinkHandlers = React.useMemo(
    () => ({
      openSessions: () => {
        if (isIPad) setIpadSidebarOpen(true);
        else setSessionsSheetOpen(true);
      },
      openView: (target: 'files' | 'mcp' | 'instances' | 'update') => {
        if (target === 'files') openFilesSurface();
        else if (target === 'mcp') setMcpOpen(true);
        else if (target === 'instances') setInstancesOpen(true);
        else if (target === 'update') setUpdateOpen(true);
      },
      openChanges: ({ path, staged }: { path?: string; staged?: boolean } = {}) => {
        openChangesSurface(path ? { path, staged: staged === true } : null);
      },
      openSettings: (section?: string) => {
        if (section) setSettingsPage(section as Parameters<typeof setSettingsPage>[0]);
        setSettingsInitialMobileStage(section ? 'page-content' : 'nav');
        setSettingsOpen(true);
      },
    }),
    [isIPad, openChangesSurface, openFilesSurface, setSettingsPage],
  );
  useDeepLinkHandlers(deepLinkHandlers);

  // Edge swipe (left/right screen edge → centre) switches between sessions, with a directional
  // slide+fade on the chat content so it's obvious the session changed.
  const chatMainRef = React.useRef<HTMLElement>(null);
  const chatAnimRef = React.useRef<HTMLDivElement>(null);
  const swipeDirectionRef = React.useRef<'prev' | 'next' | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  // Record the swipe direction; the animation itself runs in the layout effect below, once the
  // new session's content has committed — running it inline in the swipe callback raced the
  // re-render and dropped the animation on roughly every other switch.
  const recordSwipeDirection = React.useCallback((direction: 'prev' | 'next') => {
    swipeDirectionRef.current = direction;
  }, []);
  useEdgeSwipeSessionSwitch(chatMainRef, { onSwitch: recordSwipeDirection });

  React.useLayoutEffect(() => {
    const direction = swipeDirectionRef.current;
    swipeDirectionRef.current = null;
    if (!direction) return; // only animate swipe-driven switches
    const element = chatAnimRef.current;
    if (!element || typeof element.animate !== 'function') return;
    element.getAnimations().forEach((animation) => animation.cancel());
    const fromX = direction === 'prev' ? -70 : 70;
    element.animate(
      [
        { opacity: 0.1, transform: `translateX(${fromX}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [currentSessionId]);

  const handleNativeBack = React.useCallback(() => {
    if (overflowOpen) {
      setOverflowOpen(false);
      return true;
    }
    if (sessionsSheetOpen) {
      setSessionsSheetOpen(false);
      return true;
    }
    if (filesOpen) {
      setFilesOpen(false);
      return true;
    }
    if (changesOpen) {
      closeChanges();
      return true;
    }
    if (mcpOpen) {
      setMcpOpen(false);
      return true;
    }
    if (instancesOpen) {
      setInstancesOpen(false);
      return true;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return true;
    }
    if (updateOpen) {
      setUpdateOpen(false);
      return true;
    }
    return false;
  }, [changesOpen, closeChanges, filesOpen, instancesOpen, mcpOpen, overflowOpen, sessionsSheetOpen, settingsOpen, updateOpen]);

  useNativeAndroidBackButton(handleNativeBack);

  const showUpdateItem = updateAvailable && (updateRuntimeType === 'desktop' || updateRuntimeType === 'web');

  const openMcpCreateSettings = React.useCallback(() => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((server) => server.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter += 1;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      oauthEnabled: true,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
      timeout: '',
      enabled: true,
    };

    setMcpDraft(draft);
    setSelectedMcp(newName);
    setSettingsPage('mcp');
    setMcpOpen(false);
    setSettingsInitialMobileStage('page-content');
    setSettingsOpen(true);
  }, [mcpServers, setMcpDraft, setSelectedMcp, setSettingsPage]);

  const refreshMcpOverlay = React.useCallback(() => {
    if (isMcpRefreshing) return;
    setIsMcpRefreshing(true);
    const directory = currentDirectory || null;
    const minSpinPromise = new Promise((resolve) => window.setTimeout(resolve, 500));
    void Promise.all([
      refreshMcpStatus({ directory, silent: true }),
      loadMcpConfigs({ force: true }),
      minSpinPromise,
    ]).finally(() => setIsMcpRefreshing(false));
  }, [currentDirectory, isMcpRefreshing, loadMcpConfigs, refreshMcpStatus]);

  const overflowItems: OverflowItem[] = React.useMemo(
    () => {
      const items: OverflowItem[] = [];
      // iPad exposes Files/Changes as header shortcuts instead of menu items.
      if (!isIPad) {
        items.push(
          {
            key: 'files',
            icon: 'file-text',
            label: t('mobile.menu.files'),
            onSelect: () => openFilesSurface(),
          },
          {
            key: 'changes',
            icon: 'git-branch',
            label: t('mobile.menu.changes'),
            badge: dirtyChangeCount,
            onSelect: () => openChangesSurface(),
          },
        );
      }
      items.push({
        key: 'mcp',
        iconNode: <McpIcon className="size-5 shrink-0 text-muted-foreground" />,
        label: t('mobile.menu.mcp'),
        onSelect: () => setMcpOpen(true),
      });
      if (showCapacitorOnlyFeatures) {
        items.push({
          key: 'instances',
          icon: 'server',
          label: t('mobile.menu.instances'),
          onSelect: () => setInstancesOpen(true),
        });
      }
      if (showUpdateItem) {
        items.push({
          key: 'update',
          icon: 'download',
          label: t('mobile.menu.update'),
          onSelect: () => setUpdateOpen(true),
        });
      }
      items.push({
        key: 'settings',
        icon: 'settings-3',
        label: t('mobile.menu.settings'),
        onSelect: () => {
          setSettingsInitialMobileStage('nav');
          setSettingsOpen(true);
        },
      });
      return items;
    },
    [dirtyChangeCount, isIPad, openChangesSurface, openFilesSurface, showCapacitorOnlyFeatures, showUpdateItem, t],
  );

  return (
    <DedicatedMobileAppProvider actions={mobileActions}>
      <div
        className="oc-mobile-app-shell main-content-safe-area flex h-[100dvh] flex-row bg-background text-foreground"
        data-page-scroll-lock="true"
      >
        {/* iPad: persistent full-height sessions sidebar; the chat column and
            its header butt against it (iPadOS-style split layout). Always
            mounted so open/close animates width, same as the desktop Sidebar. */}
        {isIPad ? (
          <aside
            ref={leftResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 bg-sidebar will-change-[width] motion-reduce:transition-none',
              !ipadSidebarOpen && 'border-r-0',
            )}
            style={{
              width: ipadSidebarOpen ? leftResize.width : 0,
              minWidth: ipadSidebarOpen ? leftResize.width : 0,
              maxWidth: ipadSidebarOpen ? leftResize.width : 0,
              ['--oc-ipad-sidebar-width' as string]: `${leftResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
              transitionProperty: leftResize.isResizing ? 'none' : 'width, min-width, max-width',
              transitionDuration: '200ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            aria-hidden={!ipadSidebarOpen}
            data-page-scroll-lock="true"
          >
            {ipadSidebarOpen ? (
              <IpadSidebarResizeHandle
                side="left"
                isResizing={leftResize.isResizing}
                ariaLabel={t('sidebar.resize.leftPanelAria')}
                handleProps={leftResize.handleProps}
              />
            ) : null}
            <div
              className={cn(
                'flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                leftResize.isResizing && 'pointer-events-none',
                !ipadSidebarOpen && 'pointer-events-none select-none opacity-0',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden' }}
            >
              <ErrorBoundary>
                <MobileSessionsSheet
                  open
                  variant="sidebar"
                  // The surface asks to close after picking a session/project or
                  // creating a worktree; the persistent landscape sidebar stays
                  // put, portrait gives the space back to the chat.
                  onOpenChange={(value) => {
                    if (!value && isPortrait) setIpadSidebarOpen(false);
                  }}
                />
              </ErrorBoundary>
            </div>
          </aside>
        ) : null}

        <div className="flex h-full min-w-0 flex-1 flex-col" data-page-scroll-lock="true">
          <MobileHeader
            onOpenSessions={() => (isIPad ? toggleIpadSidebar() : setSessionsSheetOpen(true))}
            onOpenMenu={() => setOverflowOpen(true)}
            surfaceShortcuts={isIPad ? {
              activePanel: ipadRightPanel,
              changesDirty: dirtyChangeCount > 0,
              onToggleFiles: () => toggleIpadRightPanel('files'),
              onToggleChanges: () => toggleIpadRightPanel('changes'),
            } : undefined}
          />
          <main ref={chatMainRef} className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
            <div ref={chatAnimRef} className="h-full w-full">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </main>
        </div>

        {/* iPad: Changes/Files live in a full-height right sidebar instead of
            the phone's fullscreen surfaces. Width animates like the desktop
            RightSidebar; content stays mounted through the collapse. */}
        {isIPad ? (
          <aside
            ref={rightResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border/50 bg-background will-change-[width] motion-reduce:transition-none',
              !ipadRightPanel && 'border-l-0',
            )}
            style={{
              width: ipadRightPanel ? rightResize.width : 0,
              minWidth: ipadRightPanel ? rightResize.width : 0,
              maxWidth: ipadRightPanel ? rightResize.width : 0,
              ['--oc-ipad-sidebar-width' as string]: `${rightResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
              transitionProperty: rightResize.isResizing ? 'none' : 'width, min-width, max-width',
              transitionDuration: '200ms',
              transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            aria-hidden={!ipadRightPanel}
            data-page-scroll-lock="true"
          >
            {ipadRightPanel ? (
              <IpadSidebarResizeHandle
                side="right"
                isResizing={rightResize.isResizing}
                ariaLabel={t('sidebar.resize.rightPanelAria')}
                handleProps={rightResize.handleProps}
              />
            ) : null}
            <div
              className={cn(
                'flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                rightResize.isResizing && 'pointer-events-none',
                !ipadRightPanel && 'pointer-events-none select-none opacity-0',
              )}
              style={{ width: 'var(--oc-ipad-sidebar-width)', overflowX: 'hidden' }}
            >
              {ipadRightContentMounted ? (
                <ErrorBoundary>
                  {renderedIpadRightPanel === 'files' ? (
                    <MobileFilesSurface onClose={closeIpadRightPanel} />
                  ) : (
                    <MobileChangesSurface
                      onClose={closeIpadRightPanel}
                      initialDiffPath={pendingChangesDiff?.path ?? null}
                      initialDiffStaged={pendingChangesDiff?.staged === true}
                    />
                  )}
                </ErrorBoundary>
              ) : null}
            </div>
          </aside>
        ) : null}

        <MobileOverflowMenu
          open={overflowOpen}
          onClose={() => setOverflowOpen(false)}
          items={overflowItems}
          rightOffset={isIPad && ipadRightPanel ? rightResize.width : 0}
        />

        {sessionsSheetOpen ? (
          <MobileSessionsSheet open={sessionsSheetOpen} onOpenChange={setSessionsSheetOpen} />
        ) : null}

        {/* Mounted only while open (like the sessions sheet) so each surface
            computes its safe-area / fixed-position layout fresh on open. Keeping
            them always-mounted left a stale startup layout, which made the
            top-inset dimming appear only intermittently on iOS. */}
        {filesOpen ? (
          <MobileSurfaceShell
            open
            onClose={() => setFilesOpen(false)}
            ariaLabel={t('mobile.menu.files')}
            headerless
          >
            <ErrorBoundary>
              <MobileFilesSurface onClose={() => setFilesOpen(false)} />
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}

        {changesOpen ? (
          <MobileSurfaceShell
            open
            onClose={closeChanges}
            ariaLabel={t('mobile.menu.changes')}
            headerless
          >
            <ErrorBoundary>
              <MobileChangesSurface
                onClose={closeChanges}
                initialDiffPath={pendingChangesDiff?.path ?? null}
                initialDiffStaged={pendingChangesDiff?.staged === true}
              />
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}

        {mcpOpen ? (
          <MobileOverlayPanel
            open
            onClose={() => setMcpOpen(false)}
            title={t('mcpDropdown.title')}
            className="h-[72vh]"
            contentMaxHeightClassName="max-h-full"
            renderHeader={(closeButton) => (
              <div className="shrink-0">
                <div className="flex justify-center pt-2.5 pb-1">
                  <div className="h-1 w-9 rounded-full bg-[color-mix(in_srgb,var(--surface-mutedForeground)_40%,transparent)]" />
                </div>
                <div className="flex items-center justify-between gap-2 px-4 pb-2">
                  <h2 className="text-[16px] font-semibold text-[var(--surface-foreground)]">
                    {t('mcpDropdown.title')}
                  </h2>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
                      onClick={openMcpCreateSettings}
                      aria-label={t('settings.mcp.sidebar.actions.addServerTitle')}
                      title={t('settings.mcp.sidebar.actions.addServerTitle')}
                      style={{ touchAction: 'manipulation' }}
                    >
                      <Icon name="add" className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      className="flex size-8 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)] disabled:opacity-60"
                      onClick={refreshMcpOverlay}
                      disabled={isMcpRefreshing}
                      aria-label={t('mcpDropdown.actions.refreshAria')}
                      title={t('mcpDropdown.actions.refreshAria')}
                      style={{ touchAction: 'manipulation' }}
                    >
                      <Icon name="refresh" className={cn('h-5 w-5', isMcpRefreshing && 'animate-spin')} />
                    </button>
                    {closeButton}
                  </div>
                </div>
              </div>
            )}
          >
            <ErrorBoundary>
              <McpDropdownContent
                active
                className="h-full"
                listClassName="max-h-none"
                hideHeader
                mobileListDensity
              />
            </ErrorBoundary>
          </MobileOverlayPanel>
        ) : null}

        {instancesOpen && showCapacitorOnlyFeatures ? (
          <MobileSurfaceShell
            open
            onClose={() => setInstancesOpen(false)}
            ariaLabel={t('mobile.menu.instances')}
            title={t('mobile.menu.instances')}
          >
            <MobileInstancesSurface
              onConnect={() => setInstancesOpen(false)}
              onActiveConnectionDeleted={onActiveConnectionDeleted}
            />
          </MobileSurfaceShell>
        ) : null}

        {settingsOpen ? (
          <MobileSurfaceShell
            open
            onClose={() => setSettingsOpen(false)}
            ariaLabel={t('mobile.menu.settings')}
            headerless
          >
            <ErrorBoundary>
              <SettingsView
                forceMobile
                isWindowed
                initialMobileStage={settingsInitialMobileStage}
                visiblePageSlugs={[...MOBILE_SETTINGS_PAGES]}
                onClose={() => setSettingsOpen(false)}
              />
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}

        {updateOpen ? (
          <MobileSurfaceShell
            open
            onClose={() => setUpdateOpen(false)}
            ariaLabel={t('mobile.menu.update')}
            title={t('mobile.menu.update')}
          >
            <ErrorBoundary>
              <div className="h-full overflow-auto px-5 py-4">
                <AboutSettings initialUpdateDialogOpen />
              </div>
            </ErrorBoundary>
          </MobileSurfaceShell>
        ) : null}
      </div>
    </DedicatedMobileAppProvider>
  );
};

export function MobileApp({ apis }: MobileAppProps) {
  const { t } = useI18n();
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const worktreeDiscoveryEpoch = useSessionUIStore((state) => state.worktreeDiscoveryEpoch);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  // Cold-launch auto-connect to the last instance: 'pending'/'attempting' hold the
  // splash so we don't flash the connect screen; 'done' means we either connected or
  // exhausted the attempt (then the connect screen shows).
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  // Bumped to force a re-render (and thus a fresh `sdk` prop for SyncProvider)
  // after a same-device transport swap — reconnects the sync layer in place with
  // no remount. The value itself is unused; only the re-render matters.
  const [, bumpTransportSwitch] = React.useReducer((count: number) => count + 1, 0);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const lastNativeResumeSyncEventAtRef = React.useRef(0);
  const nativeResumeValidationSeqRef = React.useRef(0);

  const handleNativeResume = React.useCallback(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      // Already disconnected — e.g. a previous re-probe ran mid network flux
      // (Android Wi-Fi switch with no cellular fallback) and found nothing
      // reachable. When a resume/online signal arrives, silently retry the last
      // saved instance instead of dead-ending on the connect screen until the
      // user restarts the app. Success fires runtime-endpoint-changed, which
      // re-bootstraps everything.
      void autoConnectLastInstance();
      return;
    }

    // Re-probe the active device's transports on resume: the network may have
    // changed while the app slept, so hot-switch LAN⇄relay if a better transport
    // is now reachable — no re-pairing. A 'switched' outcome already fired the
    // runtime-endpoint-changed subscription (which re-bootstraps the app), so we
    // only refresh in place when the transport is 'unchanged'.
    const refreshInPlace = () => {
      void initializeApp();
      void refreshGitHubAuthStatus(apis.github, { force: true });
      if (providersCount === 0) void loadProviders({ source: 'mobileApp:nativeResume' });
      if (agentsCount === 0) void loadAgents({ source: 'mobileApp:nativeResume' });
    };
    const disconnect = () => {
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };

    void reprobeActiveConnection().then((outcome) => {
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      if (outcome === 'no-connection') {
        disconnect();
        return;
      }
      if (outcome === 'unreachable') {
        // Right after a resume or Wi-Fi switch the network is often still
        // settling (on Android without a SIM there is NO connectivity at all for
        // a few seconds), so a single fast probe races the network coming up.
        // Retry once after a grace period before tearing the connection down.
        window.setTimeout(() => {
          if (nativeResumeValidationSeqRef.current !== validationSeq) return;
          void reprobeActiveConnection().then((retry) => {
            if (nativeResumeValidationSeqRef.current !== validationSeq) return;
            if (retry === 'switched') return;
            if (retry === 'unchanged') {
              refreshInPlace();
              return;
            }
            disconnect();
          });
        }, 4000);
        return;
      }
      if (outcome === 'switched') return;

      refreshInPlace();
    });

    const now = Date.now();
    if (now - lastNativeResumeSyncEventAtRef.current >= NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS) {
      lastNativeResumeSyncEventAtRef.current = now;
      window.dispatchEvent(new Event('openchamber:system-resume'));
    }
  }, [agentsCount, apis.github, initializeApp, loadAgents, loadProviders, providersCount, refreshGitHubAuthStatus]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  // Network-change re-probe. The resume hook only fires on background→foreground,
  // but on Android switching Wi-Fi (quick-settings tile) does NOT background the
  // app — no visibility/appState event ever fires, so the app would sit on a dead
  // LAN transport instead of hot-switching to relay. The webview's `online` event
  // fires on connectivity changes (new Wi-Fi, cellular back, airplane off), so
  // run the same re-probe then. Debounced: the first seconds after `online` the
  // route is often not usable yet, and rapid offline/online flaps must collapse
  // into one probe. iOS also gets this (harmless — same seq-guarded operation the
  // resume path runs; a concurrent duplicate supersedes via the seq ref).
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    let timer: number | undefined;
    const handleOnline = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handleNativeResume(), 1500);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearTimeout(timer);
    };
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // stores still hold the previous instance's data. Mirror the web App.tsx reset
  // sequence so the UI fully re-bootstraps against the new server instead of going
  // stale. The SyncProvider is keyed by runtimeEndpointEpoch so it remounts too.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN⇄relay swap for the SAME device keeps the runtime key stable. Treat
      // that as a transport-only change: rebind the sync layer to the new
      // transport but keep the user's session/connection state — no reconnecting
      // screen, no bounce back to the draft. Only a real instance switch (key
      // change) does the full reset.
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        // Transport-only swap for the same device: rebind the SDK to the new
        // transport and force a re-render so SyncProvider receives the new `sdk`
        // prop. Its event-pipeline + bootstrap effects (keyed on `sdk`) then
        // reconnect over the new transport WITHOUT remounting — so the message
        // pagination refs, the open session, and the whole view are preserved.
        // No key bump, no flash, no bounce to the draft.
        reconnectAppForTransportSwitch();
        bumpTransportSwitch();
        return;
      }
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  // On cold launch, silently reconnect to the most-recent saved instance so a
  // returning user — and notification deep-links — land in the app instead of the
  // connect screen. The splash is held while we try (see render below). If there's
  // no saved instance, it's unreachable, or it needs a (re)login, we fall through
  // to the connect screen. A successful switchRuntimeEndpoint fires the endpoint-
  // changed subscription above, which bumps the epochs and bootstraps the app.
  React.useEffect(() => {
    if (!isNativeMobileApp || isConnected || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void autoConnectLastInstance()
      .catch(() => false)
      .then(() => {
        if (!cancelled) setAutoConnectPhase('done');
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount — auto-connect is a cold-launch concern only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    // Never bootstrap without a runtime endpoint on native: with apiBaseUrl ''
    // the resolver falls back to the webview's own origin, where Capacitor's
    // static server answers every request with index.html — the bootstrap
    // "succeeds" against a fake backend and flips isConnected back on, leaving
    // the user in an empty shell after a disconnect.
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void initializeApp();
  }, [connectionEpoch, initializeApp, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  // Gated on isConnected (and re-run on reconnect/instance switch): probing the
  // GitHub auth status before the runtime is reachable cached a "not connected"
  // answer that stuck until something else forced a re-check.
  React.useEffect(() => {
    if (!isConnected) return;
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, isConnected, refreshGitHubAuthStatus]);

  // Discover all worktrees for every known project so the draft session's
  // worktree/branch dropdown can list every available branch — not only the
  // current one. Mirrors ElectronMiniChatApp + desktop SessionSidebar.
  // Gated on isConnected: running before the runtime is reachable made every
  // per-project probe fail silently, leaving the map empty until some later
  // projects-store update happened to re-run this effect (the "switch projects
  // back and forth to see worktrees" bug).
  React.useEffect(() => {
    if (!isConnected || projects.length === 0) return;
    let cancelled = false;

    const run = async () => {
      const worktreesByProject = new Map<string, WorktreeMetadata[]>();
      // Track confirmed non-Git repos so we can prune their stale entries.
      const nonGitProjectPaths = new Set<string>();

      await Promise.all(
        projects.map(async (project) => {
          const projectPath = normalizeProjectPath(project.path);
          if (!projectPath) return;
          try {
            const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
            const isGitRepo =
              cachedIsGitRepo ?? (await import('@/lib/gitApi').then((m) => m.checkIsGitRepository(projectPath)));
            if (!isGitRepo) {
              nonGitProjectPaths.add(projectPath);
              return;
            }
            const worktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
            if (cancelled) return;
            // Always add the project, even with an empty worktree list.
            // Skipping would wipe persisted data when the store is overwritten.
            worktreesByProject.set(projectPath, worktrees);
          } catch {
            // Worktree discovery is best-effort; draft selector falls back to the project root.
            // The merge below preserves existing data for projects where discovery failed.
          }
        }),
      );

      if (cancelled) return;

      // Merge with existing store data to preserve worktrees for projects
      // where discovery failed. Prune stale entries for removed projects
      // and projects confirmed as non-Git repos.
      const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
      const currentProjectPaths = new Set(
        projects
          .map((p) => normalizeProjectPath(p.path))
          .filter((p): p is string => Boolean(p)),
      );
      const mergedByProject = new Map<string, WorktreeMetadata[]>();
      for (const [projectPath, worktrees] of worktreesByProject) {
        mergedByProject.set(projectPath, worktrees);
      }
      for (const [projectPath, worktrees] of currentByProject) {
        if (!mergedByProject.has(projectPath) && currentProjectPaths.has(projectPath) && !nonGitProjectPaths.has(projectPath)) {
          mergedByProject.set(projectPath, worktrees);
        }
      }

      useSessionUIStore.setState({
        availableWorktrees: [...mergedByProject.values()].flat(),
        availableWorktreesByProject: mergedByProject,
      });
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isConnected, projects, worktreeDiscoveryEpoch]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | { planModeExperimentalEnabled?: unknown };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      setPlanModeEnabled(raw === true || raw === 1 || raw === '1' || raw === 'true');
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    // Native: only while an instance is selected and reconnecting. Browser: the
    // runtime is same-origin (no explicit base URL), so any not-connected spell
    // counts — the splash holds until this fires, then the error screen shows.
    const waitingOnConnection = !isConnected && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowConnectionRecovery(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useUpdatePolling();
  useWindowTitle();
  useRouter();
  // APNs is the only notification channel on the native app (background-capable,
  // focus-suppressed server-side via the visibility beacon). Local notifications are
  // intentionally disabled — they can't tell foreground from background in a WKWebView
  // (document.hasFocus() is unreliable) and leaked while the app was open; the in-app SSE
  // notification dispatch is no-op'd for native in renderMobileApp.
  useNativePushRegistration({ enabled: isNativeMobileApp && isConnected });
  // Single native deep-link entry point: notification taps AND the openchamber:// URL
  // scheme (widgets, Live Activities, external links). Registered unconditionally so a
  // cold-launch tap/open isn't lost on the connect/splash screen; intents stash until
  // the app is ready (connected + initialized) and shell handlers are registered.
  useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized });
  const fontsReady = useFontsReady();

  // `isConnected` is a LIVE flag that flips false on every transient SSE/WS drop and
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // While 'reconnecting' (we were connected before), keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <OpenChamberLogo width={120} height={120} isAnimated />
      </main>
    );
  }

  // No runtime endpoint on native = explicitly disconnected (last instance
  // deleted, revoked token, unreachable). The connect screen is the only valid
  // UI then — regardless of what a stale isConnected flag claims (the store can
  // be poisoned by a bootstrap that ran against the webview's own origin).
  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());

  if (isNativeMobileApp && (!hasRuntimeEndpoint || (!isConnected && !isReconnecting))) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <OpenChamberLogo width={120} height={120} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
                  <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                    setConnectionEpoch((value) => value + 1);
                  }}
                >
                  {t('mobile.connect.cancelPassword')}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    // Cold-launch auto-connect is still resolving — hold the splash instead of
    // flashing the connect screen. Only show the connect screen once we've finished
    // (no saved instance, unreachable, or needs re-login).
    if (autoConnectPhase !== 'done') {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return <MobileConnectionWelcome onConnected={() => setConnectionEpoch((value) => value + 1)} />;
  }

  if (!isConnected && !isReconnecting) {
    // Browser: the initial connect takes a beat — hold the logo splash instead
    // of flashing the unreachable-server error while it resolves. The error
    // only shows once the recovery delay has expired (genuinely unreachable).
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <OpenChamberLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
          <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized} />
              <OpenCodeUpdateToast />
              <MobileAppUpdateToast />
              <MobileShell onActiveConnectionDeleted={() => {
                switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                setConnectionEpoch((value) => value + 1);
              }} />
              <Toaster position="top-center" offset="calc(var(--oc-safe-area-top, 0px) + 16px)" />
              {isInitialized ? <ConfigUpdateOverlay /> : null}
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
