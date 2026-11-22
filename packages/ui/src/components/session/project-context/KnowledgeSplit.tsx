import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

const LIST_WIDTH_PX = 380;

export const KnowledgeSplit: React.FC<{
  list: React.ReactNode;
  detail: React.ReactNode | null;
  emptyLabel: string;
}> = ({ list, detail, emptyLabel }) => (
  <div className="flex h-full min-h-0">
    <ScrollableOverlay
      outerClassName="h-full flex-shrink-0 border-e border-edge"
      outerStyle={{ width: LIST_WIDTH_PX }}
      className="p-3"
      disableHorizontal
    >
      {list}
    </ScrollableOverlay>
    <div className="h-full min-w-0 flex-1 overflow-hidden p-3">
      {detail ?? (
        <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  </div>
);
