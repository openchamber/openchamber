import React from 'react';

export type TileDragState = { activeTileId: string | null };

export const TileDragContext = React.createContext<TileDragState>({ activeTileId: null });

export const useTileDragState = (): TileDragState => React.useContext(TileDragContext);
