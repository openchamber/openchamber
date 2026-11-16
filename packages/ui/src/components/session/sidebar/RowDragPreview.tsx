import React from 'react';

export const RowDragPreview: React.FC<{ copy: Element }> = ({ copy }) => {
  const mount = React.useCallback((node: HTMLDivElement | null) => {
    node?.replaceChildren(copy);
  }, [copy]);
  return <div inert aria-hidden="true" className="relative h-full cursor-grabbing overflow-hidden rounded-md bg-sidebar">
    <div ref={mount} />
    <div className="oc-tile pointer-events-none absolute inset-0 rounded-md" />
  </div>;
};
