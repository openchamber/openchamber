import type React from 'react';

export const handleRowActionPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

export const handleRowActionMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
  event.preventDefault();
  event.stopPropagation();
};
