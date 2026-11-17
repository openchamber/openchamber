import React from 'react';

const AGENT_SETTLE_MS = 1_000;

export const isStageShown = (stage: HTMLElement): boolean => {
  const rect = stage.getBoundingClientRect();
  return rect.width > 0
    && rect.left >= 0
    && rect.right <= window.innerWidth
    && stage.checkVisibility({ opacityProperty: true, visibilityProperty: true });
};

const focusTarget = (event: FocusEvent): HTMLElement | null => {
  const target = event.composedPath()[0];
  return target instanceof HTMLElement ? target : null;
};

export const deepActiveElement = (): HTMLElement | null => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
};

export const useWebviewFocusGuard = (
  webview: WebviewElement | null,
  stageRef: React.RefObject<HTMLElement | null>,
) => {
  const agentActionsRef = React.useRef(0);
  const agentFocusActionsRef = React.useRef(0);
  const settleUntilRef = React.useRef(0);
  const lastFocusedRef = React.useRef<HTMLElement | null>(null);

  const giveFocusBack = React.useCallback(() => {
    if (!webview || document.activeElement !== webview) return;
    const previous = lastFocusedRef.current;
    if (previous && previous.isConnected && previous !== document.body) {
      previous.focus({ preventScroll: true });
    } else {
      webview.blur();
    }
  }, [webview]);

  React.useEffect(() => {
    if (!webview) return;
    if (document.activeElement !== webview) lastFocusedRef.current = deepActiveElement();
    const guard = () => {
      if (document.activeElement !== webview) return;
      const stage = stageRef.current;
      const agentDriving = agentActionsRef.current > agentFocusActionsRef.current
        || Date.now() < settleUntilRef.current;
      if (stage && isStageShown(stage) && !agentDriving) return;
      if (agentFocusActionsRef.current > 0) return;
      giveFocusBack();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (document.activeElement !== webview) {
        lastFocusedRef.current = focusTarget(event);
        return;
      }
      guard();
    };
    const onWindowBlur = (event: FocusEvent) => {
      if (event.target !== window) return;
      setTimeout(guard, 0);
    };
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('blur', onWindowBlur, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('blur', onWindowBlur, true);
    };
  }, [giveFocusBack, stageRef, webview]);

  return React.useCallback(async <T>(run: (holdPageFocus: HoldPageFocus) => Promise<T>): Promise<T> => {
    const userWasInPage = webview !== null && document.activeElement === webview;
    let holding = false;
    const releasePageFocus = () => {
      if (!holding) return;
      holding = false;
      agentFocusActionsRef.current -= 1;
      settleUntilRef.current = Date.now() + AGENT_SETTLE_MS;
      if (!userWasInPage && agentFocusActionsRef.current === 0) giveFocusBack();
    };
    const holdPageFocus: HoldPageFocus = () => {
      if (!holding) {
        holding = true;
        agentFocusActionsRef.current += 1;
      }
      return releasePageFocus;
    };
    agentActionsRef.current += 1;
    try {
      return await run(holdPageFocus);
    } finally {
      agentActionsRef.current -= 1;
      settleUntilRef.current = Date.now() + AGENT_SETTLE_MS;
      releasePageFocus();
      if (!userWasInPage && agentFocusActionsRef.current === 0) giveFocusBack();
    }
  }, [giveFocusBack, webview]);
};

export type HoldPageFocus = () => () => void;
