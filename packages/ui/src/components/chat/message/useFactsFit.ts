import React from 'react';

export const useFactsFit = (ref: React.RefObject<HTMLElement | null>): void => {
  const fittedRef = React.useRef<{ container: HTMLElement; text: string | null } | null>(null);
  const observedRef = React.useRef<{ container: HTMLElement; release: () => void } | null>(null);

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
    if (inCallback) return;
    inCallback = true;
    fitFacts(container);
    inCallback = false;
  };

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
