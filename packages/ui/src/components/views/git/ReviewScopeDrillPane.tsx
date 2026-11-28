import type { ReactNode } from 'react';
import { GitSidebarColumn } from './GitSidebarColumn';

export function ReviewScopeDrillPane({
  isWide, drilled, list, header, emptyOrError, selectPrompt, renderFileTree, renderSelectedFile, renderAccordion,
}: {
  isWide: boolean;
  drilled: boolean;
  list: ReactNode;
  header: ReactNode;
  emptyOrError: ReactNode;
  selectPrompt: ReactNode;
  renderFileTree: () => ReactNode;
  renderSelectedFile: () => ReactNode;
  renderAccordion: () => ReactNode;
}) {
  if (isWide) {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <GitSidebarColumn>
          {drilled && header ? (
            <>
              {header}
              {emptyOrError ? null : renderFileTree()}
            </>
          ) : list}
        </GitSidebarColumn>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {header ? (emptyOrError ?? renderSelectedFile()) : selectPrompt}
        </div>
      </div>
    );
  }
  return drilled && header ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {header}
      {emptyOrError ?? renderAccordion()}
    </div>
  ) : list;
}
