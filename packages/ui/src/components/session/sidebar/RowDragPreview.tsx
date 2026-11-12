import React from 'react';

/**
 * The row lifted under the pointer: a copy of the row as it was drawn when it
 * was picked up (`copyDragSource`), a step lighter, so it reads as the row
 * itself picked up over the rows it passes. Its place in the list stays open.
 */
export const RowDragPreview: React.FC<{ copy: Element }> = ({ copy }) => {
  const mount = React.useCallback((node: HTMLDivElement | null) => {
    node?.replaceChildren(copy);
  }, [copy]);
  return <div inert aria-hidden="true" className="relative h-full cursor-grabbing overflow-hidden rounded-md bg-sidebar">
    <div ref={mount} />
    <div className="oc-tile pointer-events-none absolute inset-0 rounded-md" />
  </div>;
};
