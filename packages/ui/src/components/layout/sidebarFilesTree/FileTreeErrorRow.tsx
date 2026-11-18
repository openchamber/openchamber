import React from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTreeIndentGuides } from '@/components/views/files/FileTreeRowParts';
import { fileTreeRowPaddingLeft } from '@/components/views/files/fileTreeRow';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

export const FileTreeErrorRow: React.FC<{
  depth: number;
  message: string;
  directory: string;
  onRefresh: (directory: string) => void;
}> = ({ depth, message, directory, onRefresh }) => {
  const { t } = useI18n();
  return (
    <div
      className="sticky inset-s-0 flex w-[100cqw] items-center gap-2 py-1 pe-2 typography-meta text-muted-foreground"
      style={{ paddingInlineStart: fileTreeRowPaddingLeft(depth) }}
    >
      <FileTreeIndentGuides depth={depth} />
      <span className="min-w-0 flex-1 truncate text-[var(--status-error)]" title={message}>{message}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="xs" className="h-6 gap-1" onClick={() => onRefresh(directory)}>
            <Icon name="refresh" className="h-3.5 w-3.5" />
            {t('sidebarFilesTree.actions.refreshTitle')}
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryFolder')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
