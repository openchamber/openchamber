import React from 'react';

/**
 * How long after an agent action the page is still treated as acting on its
 * own. A load the action started can finish, and autofocus a field, just after
 * the action has answered.
 */
const AGENT_SETTLE_MS = 1_000;

/** Whether the stage is laid out inside the window where the user can see it. */
export const isStageShown = (stage: HTMLElement): boolean => {
  const rect = stage.getBoundingClientRect();
  return rect.width > 0
    && rect.left >= 0
    && rect.right <= window.innerWidth
    && stage.checkVisibility({ opacityProperty: true, visibilityProperty: true });
};

/** The element that really holds focus, looking through shadow roots. */
const focusTarget = (event: FocusEvent): HTMLElement | null => {
  const target = event.composedPath()[0];
  return target instanceof HTMLElement ? target : null;
};

const deepActiveElement = (): HTMLElement | null => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
};

/**
 * Keeps keyboard focus where the user left it while the agent works a page.
 *
 * Chromium treats the guest page as a frame of the app window, so a page that
 * autofocuses a field, or a click the agent performs, moves focus out of
 * whatever the user was typing in. The page may take focus only when the user
 * can see it and no agent action is driving it; otherwise focus goes straight
 * back. An action that has to give the page real focus, because the desktop
 * shell could not emulate it, holds focus through `holdPageFocus` and hands it
 * back as soon as it releases the hold.
 */
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
    // A page can take focus on its very first load, before any focus change
    // has been seen here, so start from what holds it now.
    if (document.activeElement !== webview) lastFocusedRef.current = deepActiveElement();
    const onFocusIn = (event: FocusEvent) => {
      if (document.activeElement !== webview) {
        lastFocusedRef.current = focusTarget(event);
        return;
      }
      const stage = stageRef.current;
      const agentDriving = agentActionsRef.current > agentFocusActionsRef.current
        || Date.now() < settleUntilRef.current;
      if (stage && isStageShown(stage) && !agentDriving) return;
      if (agentFocusActionsRef.current > 0) return;
      giveFocusBack();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [giveFocusBack, stageRef, webview]);

  /**
   * Runs one agent action under the guard. A page the user was already in
   * keeps focus afterwards; it was theirs, not the agent's.
   */
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
    }
  }, [giveFocusBack, webview]);
};

/**
 * Lets the page keep the focus the action is about to give it; the returned
 * function hands focus back and is safe to call more than once.
 */
export type HoldPageFocus = () => () => void;
