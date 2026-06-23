import { useI18n } from '@/lib/i18n';
import React from 'react';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import type { FileNode } from './helpers';
import { getFileIcon } from './helpers';

interface FilesListProps {
  searching: boolean;
  searchResults: FileNode[];
  selectedFile: FileNode | null;
  onSelectFile: (node: FileNode) => void;
  rootLoadError: string | null;
  onRefreshRoot: () => void;
  hasTree: boolean;
  renderTree: () => React.ReactNode;
  isMobile: boolean;
}

export const FilesList: React.FC<FilesListProps> = ({
  searching,
  searchResults,
  selectedFile,
  onSelectFile,
  rootLoadError,
  onRefreshRoot,
  hasTree,
  renderTree,
  isMobile,
}) => {
  const { t } = useI18n();
  return (
    <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn("py-2", isMobile ? "px-3" : "px-2")}>
      <ul className="flex flex-col">
        {searching ? (
          <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
            <Icon name="loader-4" className="size-4 animate-spin" />
            {t('filesView.tree.search.searching')}
          </li>
        ) : searchResults.length > 0 ? (
          searchResults.map((node) => {
            const isActive = selectedFile?.path === node.path;
            return (
              <li key={node.path}>
                <button
                  type="button"
                  onClick={() => onSelectFile(node)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors',
                    isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40'
                  )}
                >
                  {getFileIcon(node.path, node.extension)}
                  <span
                    className="min-w-0 flex-1 truncate typography-meta"
                    style={{ direction: 'rtl', textAlign: 'left' }}
                    title={node.path}
                  >
                    {node.relativePath ?? node.path}
                  </span>
                </button>
              </li>
            );
          })
        ) : rootLoadError ? (
          <li className="flex flex-col gap-2 px-2 py-1 typography-meta text-muted-foreground">
            <span className="text-[var(--status-error)]">{rootLoadError}</span>
            <Button variant="outline" size="xs" className="w-fit gap-1.5" onClick={onRefreshRoot}>
              <Icon name="refresh" className="size-3.5" />
              {t('filesView.tree.actions.refreshTitle')}
            </Button>
          </li>
        ) : hasTree ? (
          renderTree()
        ) : (
          <li className="px-2 py-1 typography-meta text-muted-foreground">{t('filesView.state.loading')}</li>
        )}
      </ul>
    </ScrollableOverlay>
  );
};
