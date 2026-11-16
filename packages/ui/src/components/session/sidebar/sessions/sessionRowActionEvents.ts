import type React from 'react';

// A row's action buttons keep the press: it neither focuses the button nor
// reaches the row's own press handlers.
export const handleRowActionPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

export const handleRowActionMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
  event.preventDefault();
  event.stopPropagation();
};
