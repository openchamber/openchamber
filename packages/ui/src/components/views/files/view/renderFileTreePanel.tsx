import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DelegatedTooltip } from '@/components/ui/row-tooltip';
import { GitignoredToggleButton } from '@/components/layout/GitignoredToggleButton';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { fileTreeRowStateClassName } from '../fileTreeRow';
import { Icon } from '@/components/icon/Icon';
import { type useFileDirectory } from './useFileDirectory';
import { type useFileOpening } from './useFileOpening';
import { type useFileTreeRendering } from './useFileTreeRendering';
import { type useFileOperations } from './useFileOperations';
import { type useFileScope } from './useFileScope';
import { type useFileSearch } from './useFileSearch';
import { type useFileTabs } from './useFileTabs';
import { type useFileUploads } from './useFileUploads';
import { useI18n } from '@/lib/i18n';

export function renderFileTreePanel({ fileDirectory, fileOpening, fileTreeRendering, operations, scope, search, tabs, uploads, memoryKey, memoryReady, t }: {
  fileDirectory: Pick<ReturnType<typeof useFileDirectory>, 'childrenByDir' | 'loadErrorsByDir' | 'refreshRoot'>;
  fileOpening: Pick<ReturnType<typeof useFileOpening>, 'handleSelectFile'>;
  fileTreeRendering: Pick<ReturnType<typeof useFileTreeRendering>, 'renderTree' | 'treeListRef'>;
  operations: Pick<ReturnType<typeof useFileOperations>, 'handleOpenDialog'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'currentDirectory' | 'root' | 'treeEnabled'>;
  search: Pick<ReturnType<typeof useFileSearch>, 'debouncedSearchQuery' | 'searchInputRef' | 'searchQuery' | 'searchResults' | 'searching' | 'setSearchQuery'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  uploads: Pick<ReturnType<typeof useFileUploads>, 'canUpload' | 'isUploading' | 'pickFiles'>;
  memoryKey?: string | null;
  memoryReady?: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { childrenByDir, loadErrorsByDir, refreshRoot } = fileDirectory;
  const { handleSelectFile } = fileOpening;
  const { renderTree, treeListRef } = fileTreeRendering;
  const { handleOpenDialog } = operations;
  const { currentDirectory, root, treeEnabled } = scope;
  const { debouncedSearchQuery, searchInputRef, searchQuery, searchResults, searching, setSearchQuery } = search;
  const { selectedFile } = tabs;
  const { canUpload, isUploading, pickFiles } = uploads;

  const hasTree = Boolean(root && childrenByDir[root]);
  const rootLoadError = root ? loadErrorsByDir[root] : null;
  const isSearchActive = debouncedSearchQuery.trim().length > 0;
  const showsTree = hasTree && !searching && !isSearchActive && searchResults.length === 0 && !rootLoadError;

  return treeEnabled ? (
    <section className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex flex-col gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Icon name="search" className="pointer-events-none absolute inset-s-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('filesView.tree.search.placeholder')}
              className="h-8 ps-8 pe-8 typography-meta"
            />
            {searchQuery.trim().length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('filesView.tree.search.clearAria')}
                    className="absolute inset-e-2 top-2 inline-flex size-4 items-center justify-center text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setSearchQuery('');
                      searchInputRef.current?.focus();
                    }}
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>{t('filesView.tree.search.clearAria')}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <ToolbarTooltipButton
            label={t('filesView.tree.actions.newFileTitle')}
            icon="file-add"
            className="size-8"
            iconClassName="size-4"
            onClick={() => handleOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}
          />
          <ToolbarTooltipButton
            label={t('filesView.tree.actions.newFolderTitle')}
            icon="folder-add"
            className="size-8"
            iconClassName="size-4"
            onClick={() => handleOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}
          />
          {canUpload && (
            <ToolbarTooltipButton
              label={t('sidebarFilesTree.actions.uploadFilesTitle')}
              icon={isUploading ? 'loader-4' : 'upload-2'}
              className="size-8"
              iconClassName={cn('size-4', isUploading && 'animate-spin')}
              disabled={!root || isUploading}
              onClick={() => pickFiles(root)}
            />
          )}
          <GitignoredToggleButton className="size-8" iconClassName="size-4" />
          <ToolbarTooltipButton
            label={t('filesView.tree.actions.refreshTitle')}
            icon="refresh"
            className="size-8"
            iconClassName="size-4"
            onClick={() => void refreshRoot()}
          />
        </div>
      </div>

      <ScrollableOverlay memoryKey={memoryKey} memoryReady={memoryReady} outerClassName="flex-1 min-h-0" className="@container px-3 py-2">
        <ul ref={treeListRef} className={cn('relative flex flex-col', showsTree && 'w-max min-w-full')}>
          {searching ? (
            <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {t('filesView.tree.search.searching')}
            </li>
          ) : isSearchActive && searchResults.length === 0 ? (
            <li className="px-2 py-1 typography-meta text-muted-foreground">{t('mobile.files.search.empty')}</li>
          ) : searchResults.length > 0 ? (
            searchResults.map((node) => {
              const isActive = selectedFile?.path === node.path;
              return (
                <li key={node.path}>
                  <button
                    type="button"
                    onClick={() => void handleSelectFile(node)}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-start transition-colors',
                      fileTreeRowStateClassName(isActive)
                    )}
                  >
                    <FileTypeIcon filePath={node.path} extension={node.extension} className="size-3.5" />
                    <span
                      className="oc-ui-start-align min-w-0 flex-1 truncate typography-meta"
                      style={{ direction: 'rtl' }}
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="xs" className="w-fit gap-1.5" onClick={() => void refreshRoot()}>
                    <Icon name="refresh" className="size-3.5" />
                    {t('filesView.tree.actions.refreshTitle')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryFileList')}</TooltipContent>
              </Tooltip>
            </li>
          ) : hasTree ? (
            renderTree(root, 0)
          ) : (
            <li className="px-2 py-1 typography-meta text-muted-foreground">{t('filesView.state.loading')}</li>
          )}
        </ul>
        <DelegatedTooltip containerRef={treeListRef} />
      </ScrollableOverlay>
    </section>
  ) : null;
}
