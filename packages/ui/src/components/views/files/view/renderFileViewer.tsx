import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { type useFilePreviewRendering } from './useFilePreviewRendering';
import type React from 'react';

export function renderFileViewer({ commentPanel, content, discardDialog, extensionNotice, hasFile, isLargeFile, previewScroller, toolbar }: {
  commentPanel: React.ReactNode;
  content: React.ReactNode;
  discardDialog: React.ReactNode;
  extensionNotice: React.ReactNode;
  hasFile: boolean;
  isLargeFile: boolean;
  previewScroller: ReturnType<typeof useFilePreviewRendering>['setMainPreviewScroller'];
  toolbar: React.ReactNode;
}) {
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
    >
      {discardDialog}
      <div className="flex flex-col flex-shrink-0">
        {hasFile ? (
          <div className="flex h-9 min-w-0 shrink-0 items-center border-t border-edge-muted px-2">
            {toolbar}
          </div>
        ) : null}

      </div>

      {commentPanel}
      {extensionNotice}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay ref={previewScroller} outerClassName="h-full min-w-0" className={cn('h-full min-w-0', isLargeFile && '[overflow-anchor:none]')}>
          {content}
        </ScrollableOverlay>
      </div>
    </div>
  );
}
