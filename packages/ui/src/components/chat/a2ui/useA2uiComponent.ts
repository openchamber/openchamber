import { onDemand } from '../uiBlocks/useUiBlockComponent';

export const useA2uiSurfaceComponent = onDemand(() =>
  import('./A2uiSurface').then((module) => module.A2uiSurface),
);

export const useReplyA2uiBlockComponent = onDemand(() =>
  import('./ReplyA2uiBlock').then((module) => module.ReplyA2uiBlock),
);
