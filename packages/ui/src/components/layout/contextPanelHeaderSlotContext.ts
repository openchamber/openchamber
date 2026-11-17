import React from 'react';

export const ContextPanelHeaderSlotContext = React.createContext<HTMLElement | null>(null);

export function useInContextPanelHeader(): boolean {
  return React.useContext(ContextPanelHeaderSlotContext) !== null;
}
