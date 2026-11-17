import React from 'react';
import { createPortal } from 'react-dom';
import { ContextPanelHeaderSlotContext } from './contextPanelHeaderSlotContext';

export function ContextPanelHeaderSlotProvider({ value, children }: { value: HTMLElement | null; children: React.ReactNode }): React.ReactNode {
  return <ContextPanelHeaderSlotContext.Provider value={value}>{children}</ContextPanelHeaderSlotContext.Provider>;
}

export function ContextPanelHeaderToolbar({ children }: { children: React.ReactNode }): React.ReactNode {
  const slot = React.useContext(ContextPanelHeaderSlotContext);
  if (!slot) {
    return children;
  }
  return createPortal(
    <div data-context-panel-toolbar="" className="flex min-w-0 flex-1 items-stretch">
      {children}
    </div>,
    slot,
  );
}
