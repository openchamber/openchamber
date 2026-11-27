import React from 'react';

interface ToolbarFit {
  steps: readonly string[];
  clippedText?: string;
  clippedTextCeilingRem?: number;
  overflowSteps?: readonly string[];
}

export const DIFF_TOOLBAR_MENU_STEPS = {
  walkthrough: 'data-diff-toolbar-more-walkthrough',
} as const;

const DIFF_TOOLBAR_MENU_STEP_ORDER = [DIFF_TOOLBAR_MENU_STEPS.walkthrough];

const DIFF_TOOLBAR_FIT: ToolbarFit = {
  steps: ['data-diff-toolbar-compact-walkthrough', 'data-diff-toolbar-compact', ...DIFF_TOOLBAR_MENU_STEP_ORDER],
  clippedText: '.truncate',
  overflowSteps: DIFF_TOOLBAR_MENU_STEP_ORDER,
};

export const useToolbarFit = (ref: React.RefObject<HTMLElement | null>, fit: ToolbarFit): void => {
  const fittedRef = React.useRef<{ container: HTMLElement; signature: string } | null>(null);
  const observedRef = React.useRef<{ container: HTMLElement; release: () => void } | null>(null);
  const fitRef = React.useRef(fit);
  fitRef.current = fit;

  React.useLayoutEffect(() => {
    const container = ref.current;
    if (observedRef.current?.container !== container) {
      observedRef.current?.release();
      observedRef.current = container ? { container, release: observeResizes(container, () => fitRef.current) } : null;
    }
    if (!container) return;
    const signature = `${container.childElementCount}\0${container.textContent ?? ''}`;
    const fitted = fittedRef.current;
    if (fitted?.container === container && fitted.signature === signature) return;
    fittedRef.current = { container, signature };
    fitToolbar(container, fitRef.current);
  });

  React.useEffect(() => () => {
    observedRef.current?.release();
    observedRef.current = null;
  }, []);
};

export const useDiffToolbarFit = (ref: React.RefObject<HTMLElement | null>): void => useToolbarFit(ref, DIFF_TOOLBAR_FIT);

const atClippedTextCeiling = (text: HTMLElement, ceilingRem: number | undefined): boolean => {
  if (!ceilingRem) return false;
  const trigger = text.closest('button');
  if (!trigger) return false;
  const view = document.defaultView;
  const fontSize = view ? Number.parseFloat(view.getComputedStyle(document.documentElement).fontSize) : Number.NaN;
  const rootFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
  return trigger.getBoundingClientRect().width >= ceilingRem * rootFontSize - 1;
};

const fits = (container: HTMLElement, clippedText: string | undefined, clippedTextCeilingRem: number | undefined): boolean => {
  if (container.scrollWidth > container.clientWidth + 1) return false;
  if (!clippedText) return true;
  for (const text of container.querySelectorAll<HTMLElement>(clippedText)) {
    if (text.scrollWidth > text.clientWidth + 1 && !atClippedTextCeiling(text, clippedTextCeilingRem)) return false;
  }
  return true;
};

export const fitToolbar = (container: HTMLElement, { steps, clippedText, clippedTextCeilingRem, overflowSteps }: ToolbarFit = DIFF_TOOLBAR_FIT): void => {
  for (const step of steps) container.removeAttribute(step);
  for (const step of steps) {
    if (fits(container, overflowSteps?.includes(step) ? undefined : clippedText, clippedTextCeilingRem)) return;
    container.setAttribute(step, '');
  }
};

const observeResizes = (container: HTMLElement, currentFit: () => ToolbarFit): (() => void) => {
  let inCallback = false;
  const refit = () => {
    if (inCallback) return;
    inCallback = true;
    fitToolbar(container, currentFit());
    inCallback = false;
  };
  const fonts = globalThis.document?.fonts ?? null;
  fonts?.addEventListener('loadingdone', refit);
  const observer = new ResizeObserver(refit);
  observer.observe(container);
  return () => {
    fonts?.removeEventListener('loadingdone', refit);
    observer.disconnect();
  };
};
