import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RiAddLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFolderLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { useI18n } from '@/lib/i18n';

type Props = {
  selectedCount: number;
  scopeKey: string | null;
  scopeFolders: SessionFolder[];
  archivedBucket: boolean;
  onMoveToFolder: (folderId: string) => void;
  onCreateFolderAndMove: () => void;
  onRemoveFromFolder: () => void;
  canRemoveFromFolder: boolean;
  onDelete: () => void;
  onDone: () => void;
};

export const BulkActionBar: React.FC<Props> = ({
  selectedCount,
  scopeKey,
  scopeFolders,
  archivedBucket,
  onMoveToFolder,
  onCreateFolderAndMove,
  onRemoveFromFolder,
  canRemoveFromFolder,
  onDelete,
  onDone,
}) => {
  const { t } = useI18n();
  const canMoveToFolder = Boolean(scopeKey) && !archivedBucket;
  const destructiveLabel = archivedBucket
    ? t('sessions.sidebar.bulkActions.delete')
    : t('sessions.sidebar.bulkActions.archive');
  const iconButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
  const destructiveIconButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50';

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-2.5 py-1.5">
      <span className="typography-ui-label text-muted-foreground whitespace-nowrap">
        {t('sessions.sidebar.bulkActions.selectedCount', { count: selectedCount })}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        {canMoveToFolder ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={iconButtonClass}
                    aria-label={t('sessions.sidebar.bulkActions.moveToFolder')}
                  >
                    <RiFolderLine className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.bulkActions.moveToFolder')}</p></TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              {scopeFolders.length === 0 ? (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t('sessions.sidebar.folders.none')}
                </DropdownMenuItem>
              ) : (
                scopeFolders.map((folder) => (
                  <DropdownMenuItem key={folder.id} onClick={() => onMoveToFolder(folder.id)}>
                    <span className="flex-1 truncate">{folder.name}</span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onCreateFolderAndMove}>
                <RiAddLine className="mr-1 h-4 w-4" />
                {t('sessions.sidebar.folders.newFolderEllipsis')}
              </DropdownMenuItem>
              {canRemoveFromFolder ? (
                <DropdownMenuItem
                  onClick={onRemoveFromFolder}
                  className="text-destructive focus:text-destructive"
                >
                  <RiCloseLine className="mr-1 h-4 w-4" />
                  {t('sessions.sidebar.folders.removeFromFolder')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDelete}
              className={cn(destructiveIconButtonClass)}
              aria-label={destructiveLabel}
            >
              <RiDeleteBinLine className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}><p>{destructiveLabel}</p></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDone}
              className={iconButtonClass}
              aria-label={t('sessions.sidebar.header.actions.exitSelection')}
            >
              <RiCloseLine className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.header.actions.exitSelection')}</p></TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
