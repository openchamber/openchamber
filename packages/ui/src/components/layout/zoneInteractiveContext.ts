import React from 'react';

import type { ContextPanelMode } from '@/stores/useUIStore';

export const ZoneInteractiveContext = React.createContext(true);

export const useZoneInteractive = (): boolean => React.useContext(ZoneInteractiveContext);

let detachableEditors = 0;

export const DetachableEditorMarker: React.FC = () => {
  React.useLayoutEffect(() => {
    detachableEditors += 1;
    return () => {
      detachableEditors -= 1;
    };
  }, []);
  return null;
};

const leavesInertOnOpen = (mode: ContextPanelMode | undefined): boolean => mode === 'file' && detachableEditors > 0;

export const isZoneExposed = (isOpen: boolean, settledOpen: boolean, mode: ContextPanelMode | undefined): boolean => (
  settledOpen || (isOpen && leavesInertOnOpen(mode))
);
