import React from 'react';

import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export const FileTreeDropIndicator: React.FC<{
  uploadTarget: string | null;
  isUploading: boolean;
  uploadTargetLabel: string;
  moveTarget: string | null;
  moveTargetLabel: string;
}> = ({ uploadTarget: dropIndicatorTarget, isUploading, uploadTargetLabel: dropTargetLabel, moveTarget: moveDropTarget, moveTargetLabel: moveDropTargetLabel }) => {
  const { t } = useI18n();
  return dropIndicatorTarget ? (
      <div className="pointer-events-none absolute inset-s-2 inset-e-2 top-2 z-50 flex items-center gap-2 rounded-md border border-primary bg-background/95 px-2 py-1.5 shadow-sm">
        <Icon name={isUploading ? 'loader-4' : 'folder-received'} className={cn('size-4 flex-shrink-0', isUploading && 'animate-spin')} />
        <span className="min-w-0 truncate typography-meta" title={dropTargetLabel}>
          {t(isUploading ? 'sidebarFilesTree.drop.uploading' : 'sidebarFilesTree.drop.target', { path: dropTargetLabel })}
        </span>
      </div>
    ) : moveDropTarget ? (
      <div className="pointer-events-none absolute inset-s-2 inset-e-2 top-2 z-50 flex items-center gap-2 rounded-md border border-primary bg-background/95 px-2 py-1.5 shadow-sm">
        <Icon name="folder-received" className="size-4 flex-shrink-0" />
        <span className="min-w-0 truncate typography-meta" title={moveDropTargetLabel}>
          {t('sidebarFilesTree.drop.moveTarget', { path: moveDropTargetLabel })}
        </span>
      </div>
    ) : null;
};
