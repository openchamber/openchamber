import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { StackedDiffWindow, STACKED_DIFF_WINDOW_THRESHOLD } from '../diffView/StackedDiffWindow';
import { isFindRevealFor } from '../diffView/diffData';
import type { FileEntry } from '../diffView/types';

export type { StackedEntryHandles } from '../diffView/StackedDiffWindow';

type StackedDiffWindowProps = React.ComponentProps<typeof StackedDiffWindow>;

interface ReviewScopeAccordionProps {
  listKey: string;
  files: FileEntry[];
  expandedFiles: ReadonlySet<string>;
  findRevealKey: string | null;
  registerSectionRef: (path: string, node: HTMLElement | null) => void;
  onToggle: (path: string, expanded: boolean) => void;
  onLiveChange: (path: string, live: boolean) => void;
  renderEntry: StackedDiffWindowProps['renderEntry'];
}

export function ReviewScopeAccordion({
  listKey, files, expandedFiles, findRevealKey, registerSectionRef, onToggle, onLiveChange, renderEntry,
}: ReviewScopeAccordionProps) {
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const windowed = files.length >= STACKED_DIFF_WINDOW_THRESHOLD;
  const revealPath = findRevealKey === null
    ? null
    : files.find(({ path }) => isFindRevealFor(path, findRevealKey))?.path ?? null;
  const pinnedFiles = React.useMemo(() => new Set(revealPath ? [revealPath] : []), [revealPath]);

  return (
    <ScrollableOverlay
      ref={scrollRef}
      outerClassName="flex-1 min-h-0"
      disableHorizontal
      preventOverscroll
      data-diff-virtual-root={windowed ? 'windowed' : ''}
    >
      <div className="flex flex-col pb-4" data-diff-virtual-content>
        <StackedDiffWindow
          key={listKey}
          files={files}
          windowed={windowed}
          scrollRef={scrollRef}
          expandedFiles={expandedFiles}
          pinnedFiles={pinnedFiles}
          registerPlaceholder={registerSectionRef}
          onActivate={onToggle}
          onLiveChange={onLiveChange}
          renderEntry={renderEntry}
        />
      </div>
    </ScrollableOverlay>
  );
}
