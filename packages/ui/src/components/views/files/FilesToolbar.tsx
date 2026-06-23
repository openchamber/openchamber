import React from 'react';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface FilesToolbarProps {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  isMobile: boolean;
}

export const FilesToolbar: React.FC<FilesToolbarProps> = ({
  searchQuery,
  onSearchQueryChange,
  onNewFile,
  onNewFolder,
  onRefresh,
  isMobile,
  }) => {
  const { t } = useI18n();
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div className={cn("flex flex-col gap-2 py-2", isMobile ? "px-3" : "px-2")}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Icon name="search" className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder={t('filesView.tree.search.placeholder')}
            className="h-8 pl-8 pr-8 typography-meta"
          />
          {searchQuery.trim().length > 0 && (
            <button
              type="button"
              aria-label={t('filesView.tree.search.clearAria')}
              className="absolute right-2 top-2 inline-flex size-4 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => {
                onSearchQueryChange('');
                searchInputRef.current?.focus();
              }}
            >
              <Icon name="close" className="size-4" />
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={onNewFile}
                className="size-8 p-0 flex-shrink-0"
                title={t('filesView.tree.actions.newFileTitle')}
                aria-label={t('filesView.tree.actions.newFileTitle')}
              >
                <Icon name="file-add" className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.actions.newFileTitle')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={onNewFolder}
                className="size-8 p-0 flex-shrink-0"
                title={t('filesView.tree.actions.newFolderTitle')}
                aria-label={t('filesView.tree.actions.newFolderTitle')}
              >
                <Icon name="folder-add" className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.actions.newFolderTitle')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={onRefresh} className="size-8 p-0 flex-shrink-0" title={t('filesView.tree.actions.refreshTitle')} aria-label={t('filesView.tree.actions.refreshTitle')}>
                <Icon name="refresh" className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.actions.refreshTitle')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
