import React from 'react';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';

type UiBlockComponent = React.ComponentType<React.ComponentProps<typeof import('./UiBlock').UiBlock>>;

// Kept once loaded, so a block that remounts (virtualized rows) draws at once.
let loaded: UiBlockComponent | null = null;
const load = () => import('./UiBlock').then((module) => {
  loaded = module.UiBlock;
  return module.UiBlock;
});

/** The block renderer, loaded with the first block on screen; null until then or when loading failed. */
export function useUiBlockComponent(): UiBlockComponent | null {
  const [failed, setFailed] = React.useState(false);
  const requested = useOnDemandComponent(!loaded && !failed, load, () => setFailed(true));
  return loaded ?? requested;
}
