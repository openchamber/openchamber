import React from 'react';

/**
 * Keeps the assistant footer's facts on one line by dropping the least
 * important ones until the rest fit.
 *
 * The row itself never overflows — the model name truncates instead — so "did
 * it fit" is read off the model, and facts marked `data-fact-priority` are
 * hidden in that order (1 goes first) until the model is whole again. That is
 * the rule the design asks for: the timestamp goes, then the agent, then the
 * thinking effort, and only a row with nothing left to give truncates the
 * model.
 *
 * CSS alone cannot do this. Hiding on container-width breakpoints guesses at
 * the model's length and drops facts that would have fitted, and wrapping the
 * overflow onto a clipped second line leaves the dropped fact's width behind as
 * a hole in the middle of the row.
 *
 * Measuring forces a layout (it un-hides the facts, then reads widths), so
 * after a render it runs only when the row mounted or its text changed; a
 * resize or a web font finishing loading refits through the listeners.
 */
export const useFactsFit = (ref: React.RefObject<HTMLElement | null>): void => {
  // The row last fitted and its text then. Reading textContent forces no layout.
  const fittedRef = React.useRef<{ container: HTMLElement; text: string | null } | null>(null);
  const observedRef = React.useRef<{ container: HTMLElement; release: () => void } | null>(null);

  // After a render that mounted the row or changed its text: the facts change
  // while a turn finishes (the duration keeps counting), and that changes what
  // fits without changing any box the observer watches.
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (observedRef.current?.container !== container) {
      observedRef.current?.release();
      observedRef.current = container ? { container, release: observeResizes(container) } : null;
    }
    if (!container) return;
    const fitted = fittedRef.current;
    if (fitted?.container === container && fitted.text === container.textContent) return;
    fittedRef.current = { container, text: container.textContent };
    fitFacts(container);
  });

  React.useEffect(() => () => {
    observedRef.current?.release();
    observedRef.current = null;
  }, []);
};

const fitFacts = (container: HTMLElement): void => {
  const model = container.querySelector<HTMLElement>('[data-fact-model]');
  if (!model) return;

  const facts = Array.from(container.querySelectorAll<HTMLElement>('[data-fact-priority]'))
    .sort((left, right) => Number(left.dataset.factPriority) - Number(right.dataset.factPriority));

  for (const fact of facts) fact.style.display = '';

  const modelFits = () => model.scrollWidth <= model.clientWidth + 1;
  for (const fact of facts) {
    if (modelFits()) return;
    fact.style.display = 'none';
  }
};

const observeResizes = (container: HTMLElement): (() => void) => {
  let inCallback = false;
  const refit = () => {
    // Hiding a fact never resizes the row (its width comes from the layout
    // above it), but guard the re-entry anyway.
    if (inCallback) return;
    inCallback = true;
    fitFacts(container);
    inCallback = false;
  };

  // The window covers the common cases (a desktop window resized, a phone
  // rotated); the observer covers the ones that leave the window alone —
  // a sidebar opening, a panel dragged wider.
  // A web font arriving after the first fit changes the model's width
  // without changing the row's text or its box, so neither trigger above
  // fires; a finished turn would stay clipped.
  const fonts = globalThis.document?.fonts ?? null;
  window.addEventListener('resize', refit);
  fonts?.addEventListener('loadingdone', refit);
  const observer = new ResizeObserver(refit);
  observer.observe(container);
  return () => {
    window.removeEventListener('resize', refit);
    fonts?.removeEventListener('loadingdone', refit);
    observer.disconnect();
  };
};
