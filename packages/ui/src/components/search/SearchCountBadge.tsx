import React from 'react';

// Shows how many filters are active. The button's aria-label speaks the count, so the badge is hidden from assistive tech.
export const SearchCountBadge: React.FC<{ count: number }> = ({ count }) => count > 0
  ? <span data-search-count-badge aria-hidden="true" className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-interactive-selection px-1 typography-micro tabular-nums text-interactive-selection-foreground">{count}</span>
  : null;
