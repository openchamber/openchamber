import React from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileContentSearchResults } from '@/components/views/files/FileContentSearchResults';
import type { useFileContentSearch } from '@/components/views/files/useFileContentSearch';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { fileTreeRowStateClassName } from '@/components/views/files/fileTreeRow';
import { INTERNAL_FILE_PATH_TYPE } from '@/components/chat/composer/attachments/dataTransfer';
import type { FileContentSearchMatch } from '@/lib/api/types';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { recordFileTreeDragStart, shouldTreatFileTreeDragEndAsClick } from '../fileTreeDragClick';
import { setFileTreeDragSource } from '../fileTreeMoveDrag';
import type { FileNode } from './fileNode';
import { getRelativePath } from './treePaths';

export const FileTreeFallbackList: React.FC<{
  root: string;
  selectedPath: string | null;
  contentSearchActive: boolean;
  contentSearch: ReturnType<typeof useFileContentSearch>;
  openedMatch: { path: string; key: string } | null;
  searching: boolean;
  isSearchActive: boolean;
  searchResults: FileNode[];
  rootLoadError: string | null | undefined;
  hasTree: boolean;
  onOpenMatch: (match: FileContentSearchMatch, options?: { pin?: boolean }) => Promise<void>;
  onMatchDragStart: (event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => void;
  onMatchDragEnd: (event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => void;
  onOpenFile: (node: FileNode, options?: { pin?: boolean }) => Promise<void>;
  onRefreshRoot: () => Promise<void>;
}> = ({
  root,
  selectedPath,
  contentSearchActive,
  contentSearch,
  openedMatch,
  searching,
  isSearchActive,
  searchResults,
  rootLoadError,
  hasTree,
  onOpenMatch: handleOpenMatch,
  onMatchDragStart: handleMatchDragStart,
  onMatchDragEnd: handleMatchDragEnd,
  onOpenFile: handleOpenFile,
  onRefreshRoot: refreshRoot,
}) => {
  const { t } = useI18n();
  return (
      <ul className="flex flex-col">
        {contentSearchActive && contentSearch.status !== 'idle' ? (
          <FileContentSearchResults
            state={contentSearch}
            activeMatchKey={openedMatch && openedMatch.path === selectedPath ? openedMatch.key : null}
            onOpen={handleOpenMatch}
            onDragStart={handleMatchDragStart}
            onDragEnd={handleMatchDragEnd}
          />
        ) : searching ? (
          <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
            {t('sidebarFilesTree.state.searching')}
          </li>
        ) : isSearchActive && searchResults.length === 0 ? (
          <li className="px-2 py-1 typography-meta text-muted-foreground">{t('mobile.files.search.empty')}</li>
        ) : searchResults.length > 0 ? (
          searchResults.map((node) => {
            const isActive = selectedPath === node.path;
            return (
              <li key={node.path} data-file-tree-path={node.path}>
                <button
                  type="button"
                  onClick={() => handleOpenFile(node)}
                  onDoubleClick={() => handleOpenFile(node, { pin: true })}
                  draggable
                  onDragStart={(e) => {
                    recordFileTreeDragStart(e);
                    // Search results attach to the chat only; they never move.
                    setFileTreeDragSource(null);
                    const path = node.relativePath || getRelativePath(root ?? '', node.path);
                    if (!path || path === '.') return;
                    e.dataTransfer.setData(INTERNAL_FILE_PATH_TYPE, path);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={(e) => {
                    // A micro-drag suppressed the click this gesture was meant to be (#2368).
                    if (shouldTreatFileTreeDragEndAsClick(e)) {
                      void handleOpenFile(node);
                    }
                  }}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-start transition-colors',
                    fileTreeRowStateClassName(isActive)
                  )}
                  title={node.path}
                >
                  <FileTypeIcon filePath={node.path} extension={node.extension} className="size-3.5" />
                  <span
                    className="oc-ui-start-align min-w-0 flex-1 truncate typography-meta"
                    style={{ direction: 'rtl' }}
                  >
                    {/* Left-to-right marks keep a leading "." in place inside the rtl box. */}
                    {`\u200E${node.relativePath ?? node.path}\u200E`}
                  </span>
                </button>
              </li>
            );
          })
        ) : rootLoadError ? (
          <li className="flex flex-col gap-2 px-2 py-1 typography-meta text-muted-foreground">
            <span>{rootLoadError}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="xs" className="w-fit gap-1.5" onClick={() => void refreshRoot()}>
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                  {t('sidebarFilesTree.actions.refreshTitle')}
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryFileList')}</TooltipContent>
            </Tooltip>
          </li>
        ) : hasTree && root ? null : (
          <li className="px-2 py-1 typography-meta text-muted-foreground">{t('sidebarFilesTree.state.loading')}</li>
        )}
      </ul>
  );
};
