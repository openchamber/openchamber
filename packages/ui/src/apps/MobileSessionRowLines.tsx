import React from 'react';

import type { SessionRowLines } from '@/stores/useSessionDisplayStore';

export const MobileSessionRowLines: React.FC<{
  rowLines: SessionRowLines;
  contextLabel?: string;
  children: React.ReactNode;
}> = ({ rowLines, contextLabel, children }) => (
  <span data-mobile-row-lines={rowLines} className="flex min-w-0 flex-1 flex-col">
    <span data-mobile-row-title-line className="flex items-center gap-2.5">{children}</span>
    {rowLines === 'two' || contextLabel ? (
      <span data-mobile-row-context-line dir="auto" className="oc-ui-start-align block h-4 min-w-0 truncate typography-micro text-muted-foreground">
        {contextLabel}
      </span>
    ) : null}
  </span>
);
