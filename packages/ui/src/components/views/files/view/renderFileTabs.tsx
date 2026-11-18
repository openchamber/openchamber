import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { getDisplayPath } from './fileViewPaths';
import { FileNameText, ScrollingFileName } from './FileNameText';
import { type useFileOpening } from './useFileOpening';
import { type useFileClosing } from './useFileClosing';
import { type useFileLayout } from './useFileLayout';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { useI18n } from '@/lib/i18n';

export function renderFileTabs({ fileClosing, fileOpening, layout, scope, tabs, alwaysShowActions, isMobile, t }: {
  fileClosing: Pick<ReturnType<typeof useFileClosing>, 'handleCloseFile'>;
  fileOpening: Pick<ReturnType<typeof useFileOpening>, 'handleSelectFile'>;
  layout: Pick<ReturnType<typeof useFileLayout>, 'setShowMobilePageContent' | 'showMobilePageContent'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'editorTabsOverflow' | 'editorTabsScrollRef' | 'getOpenFileFolder' | 'openFiles' | 'selectedFile'>;
  alwaysShowActions: boolean;
  isMobile: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { handleCloseFile } = fileClosing;
  const { handleSelectFile } = fileOpening;
  const { setShowMobilePageContent, showMobilePageContent } = layout;
  const { root } = scope;
  const { editorTabsOverflow, editorTabsScrollRef, getOpenFileFolder, openFiles, selectedFile } = tabs;
  return (
        <div className="flex min-w-0 items-center px-3 py-1.5">
          {isMobile && showMobilePageContent && (
            <button
              type="button"
              onClick={() => setShowMobilePageContent(false)}
              aria-label={t('filesView.editor.back')}
              className="inline-flex size-7 flex-shrink-0 items-center justify-center me-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="arrow-left-s" className="size-5" />
            </button>
          )}

          {isMobile ? (
            selectedFile ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-w-0 max-w-full items-center gap-1 text-start typography-ui-label font-medium"
                    aria-label={t('filesView.editor.openFilesAria')}
                  >
                    <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="size-3.5 flex-shrink-0" />
                    <ScrollingFileName name={selectedFile.name} folder={getOpenFileFolder(selectedFile.path)} />
                    <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <DropdownMenuItem
                        key={file.path}
                        onSelect={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest('[data-close-open-file]')) {
                            event.preventDefault();
                            return;
                          }
                          if (!isActive) {
                            void handleSelectFile(file);
                          }
                        }}
                        className={cn(
                          'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                          isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                          <ScrollingFileName name={file.name} folder={getOpenFileFolder(file.path)} />
                        </span>
                        <button
                          type="button"
                          data-close-open-file
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                          aria-label={t('filesView.editor.closeFileAria', { name: file.name })}
                        >
                          <Icon name="close" className="size-3.5" />
                        </button>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>
            )
          ) : (
            openFiles.length > 0 ? (
              <div className="relative min-w-0 flex-1">
                {editorTabsOverflow.start && (
                  <div className="pointer-events-none absolute inset-s-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r rtl:bg-gradient-to-l from-background to-transparent" />
                )}
                {editorTabsOverflow.end && (
                  <div className="pointer-events-none absolute inset-e-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l rtl:bg-gradient-to-r from-background to-transparent" />
                )}
                <div
                  ref={editorTabsScrollRef}
                  className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    const folder = getOpenFileFolder(file.path);
                    return (
                      <div
                        key={file.path}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                          isActive
                            ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                            : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
                        )}
                      >
                        <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            if (!isActive) {
                              void handleSelectFile(file);
                            }
                          }}
                          title={getDisplayPath(root, file.path)}
                          className={cn(!folder && 'max-w-[12rem]', 'truncate text-start')}
                        >
                          <FileNameText name={file.name} folder={folder} />
                        </button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleCloseFile(file.path);
                              }}
                              className={cn(
                                'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                                !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100'
                              )}
                              aria-label={t('filesView.editor.closeFileAria', { name: file.name })}
                            >
                              <Icon name="close" className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={6}>{t('filesView.editor.closeFileAria', { name: file.name })}</TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="typography-ui-label font-medium truncate">{t('filesView.editor.selectFile')}</div>
            )
          )}
        </div>
  );
}
