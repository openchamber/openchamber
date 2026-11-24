import React from 'react';
import { DiffFindBar } from '../diffFind/DiffFindBar';
import type { UseDiffFindResult } from '../diffFind/useDiffFind';

export const GitDiffFindBar: React.FC<{ find: UseDiffFindResult; focusNonce: number }> = ({ find, focusNonce }) => (
  find.isOpen ? (
    <DiffFindBar
      query={find.query}
      onQueryChange={find.setQuery}
      total={find.matches.length}
      currentIndex={find.currentIndex}
      isSearching={find.isSearching}
      failedCount={find.failedCount}
      onNext={find.next}
      onPrevious={find.previous}
      onClose={find.close}
      focusNonce={focusNonce}
    />
  ) : null
);
