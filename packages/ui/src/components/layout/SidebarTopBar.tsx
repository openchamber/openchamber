import React from 'react';
import { titlebarControlsWidthReaderRef } from './titlebarControlsWidth';

// external: https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions No-drag regions must also cover the strip beneath overlay buttons.
export const SidebarTopBar: React.FC<{ actionsSlotRef: React.Ref<HTMLDivElement> }> = ({ actionsSlotRef }) => (
  <div
    className="flex shrink-0"
    style={{ height: 'var(--oc-header-height, 3rem)' }}
  >
    <div
      aria-hidden
      className="app-region-drag shrink-0"
      style={{ width: 'var(--oc-titlebar-start-inset, 0.75rem)' }}
    />
    <div
      aria-hidden
      ref={titlebarControlsWidthReaderRef}
      className="app-region-no-drag shrink-0"
      style={{ width: 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)' }}
    />
    <div className="app-region-drag flex min-w-0 flex-1 items-center justify-end">
      <div ref={actionsSlotRef} className="app-region-no-drag flex items-center" />
    </div>
  </div>
);
