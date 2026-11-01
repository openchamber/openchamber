import React from 'react';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';

/**
 * A component loaded with the first block on screen: null until then or when
 * loading failed. Kept once loaded, so a block that remounts (virtualized
 * rows) draws at once.
 */
function onDemand<Props extends object>(load: () => Promise<React.ComponentType<Props>>) {
  let loaded: React.ComponentType<Props> | null = null;
  const loadOnce = () => load().then((component) => {
    loaded = component;
    return component;
  });
  return function useLoadedComponent(): React.ComponentType<Props> | null {
    const [failed, setFailed] = React.useState(false);
    const requested = useOnDemandComponent(!loaded && !failed, loadOnce, () => setFailed(true));
    return loaded ?? requested;
  };
}

/** The block renderer, for a page an agent showed. */
export const useUiBlockComponent = onDemand(() => import('./UiBlock').then((module) => module.UiBlock));

/** A reply's block with its answer; it keeps the session sync out of the Markdown renderer. */
export const useReplyUiBlockComponent = onDemand(() => import('./ReplyUiBlock').then((module) => module.ReplyUiBlock));
