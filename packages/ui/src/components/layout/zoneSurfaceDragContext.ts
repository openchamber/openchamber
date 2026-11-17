import React from 'react';

type ZoneSurfaceDragOut = (isOutside: (point: { x: number; y: number }) => boolean) => {
  finish: () => boolean;
  cancel: () => void;
};

export const ZoneSurfaceDragContext = React.createContext<ZoneSurfaceDragOut | null>(null);

export const useZoneSurfaceDragOut = (): ZoneSurfaceDragOut | null => React.useContext(ZoneSurfaceDragContext);
