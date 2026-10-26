import React from 'react';

/** Width of the list column in the split layout. */
const LIST_WIDTH_PX = 380;

/**
 * A wide panel shows the list and the open entry side by side.
 *
 * Stretched to the full width of an expanded panel, the one-column layout ran
 * note lines 1500px long and swapped the whole list away to open one entry.
 * Here the list keeps a readable width and stays put, the selected card is
 * marked, and the entry opens beside it. The panel decides when it is wide
 * enough (`ProjectNotesTodoPanel`).
 */
export const KnowledgeSplit: React.FC<{
  list: React.ReactNode;
  /** The open entry, or null for the quiet hint. */
  detail: React.ReactNode | null;
  emptyLabel: string;
}> = ({ list, detail, emptyLabel }) => (
  <div className="flex h-full min-h-0">
    <div
      className="h-full flex-shrink-0 overflow-y-auto border-e border-border/60 p-3"
      style={{ width: LIST_WIDTH_PX }}
    >
      {list}
    </div>
    <div className="h-full min-w-0 flex-1 overflow-hidden p-3">
      {detail ?? (
        <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  </div>
);
