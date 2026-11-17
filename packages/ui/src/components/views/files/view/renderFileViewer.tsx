import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DocumentSymbolsPanel } from '../../DocumentSymbolsPanel';
import { DetachableEditorMarker } from '@/components/layout/zoneInteractiveContext';
import { MarkdownPreviewSearch } from '../../MarkdownPreviewSearch';
import { MarkdownPreviewOutline } from '../../MarkdownPreviewOutline';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { DiagramEditor } from '@/components/diagram';
import { FilePreviewCommentMenu } from '@/components/comments';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ContentState } from '@/components/ui/content-state';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { getDisplayPath } from './fileViewPaths';
import { FileNameText, ScrollingFileName } from './FileNameText';
import { FilePositionEditor } from './FilePositionEditor';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileComments } from './useFileComments';
import type { useFileOpening } from './useFileOpening';
import type { useFileClosing } from './useFileClosing';
import type { useFileKinds } from './useFileKinds';
import type { useFilePreviewModes } from './useFilePreviewModes';
import type { useFileNavigation } from './useFileNavigation';
import type { useFileEditorExtensions } from './useFileEditorExtensions';
import type { useFileAssets } from './useFileAssets';
import type { useArtifactPreview } from './useArtifactPreview';
import type { useFilePreviewRendering } from './useFilePreviewRendering';
import type { useFileToolbar } from './useFileToolbar';
import type { useFileCanvas } from './useFileCanvas';

export function renderFileViewer({
  mode, visible, t, runtime, isMobile, alwaysShowActions, root, showEditorTabsRow, showMobilePageContent,
  setShowMobilePageContent, isFullscreen, isSearchOpen, setIsSearchOpen, textViewMode, jsonViewMode, htmlViewMode,
  setHtmlViewMode, drawioViewMode, drawioRemountNonce, htmlViewModeByPathRef, openFiles, getOpenFileFolder,
  selectedFile, editorTabsScrollRef, editorTabsOverflow, fileContent, fileLoading, fileError, editorDocumentPath,
  filePositionKey, draftContent, setDraftContent, isSaving, diagramEditorRef, confirmDiscardOpen,
  setConfirmDiscardOpen, editorViewRef, editorWrapperRef, setEditorViewReadyNonce, isSymbolsOpen, setIsSymbolsOpen,
  mdPreviewFindOpen, setMdPreviewFindOpen, mdPreviewFindFocusNonce, mdPreviewOutlineOpen, setMdPreviewOutlineOpen,
  mdPreviewContainerRef, focusMdPreviewContainer, lineSelection, fileEditorKeymap, markdownPreviewRef,
  lineNumbersConfig, handleSelectFile, discardAndContinue, saveAndContinue, handleCloseFile,
  shouldMaskEditorForPendingNavigation, canEdit, isMarkdown, isJson, isHtml, isDrawio, suggestExcalidrawExtension,
  canUseShikiFileView, getMdViewMode, handleDiagramChange, diagramEditorXml, nudgeEditorSelectionAboveKeyboard,
  previewFontStyle, applyGitBaseline, editorExtensions, htmlPreviewUnreachable, htmlPreview, htmlPreviewFrameRef,
  htmlPreviewAnnotation, annotateWhenLoadedRef, isPdfAssetAuthLoading, artifactPreview, fileLoadingState,
  renderFileErrorState, blockWidgets, mainViewVirtualizer, showCanvas, restoreMainCodeScroll,
  setMainPreviewScroller, setMainMarkdownScroller, markdownDocumentAssets, isLargeFile, renderShikiFileView,
  renderFileToolbar, canvasInFullscreen, canvasElement, openExcalidrawExtensionCard, wholeFileCommentPanel,
}: Pick<FilesViewOptions, 'mode' | 'visible'> &
Pick<ReturnType<typeof useFilesViewState>,
  't' | 'runtime' | 'isMobile' | 'alwaysShowActions' | 'root' | 'showEditorTabsRow' | 'showMobilePageContent' |
  'setShowMobilePageContent' | 'isFullscreen' | 'isSearchOpen' | 'setIsSearchOpen' | 'textViewMode' |
  'jsonViewMode' | 'htmlViewMode' | 'setHtmlViewMode' | 'drawioViewMode' | 'drawioRemountNonce' |
  'htmlViewModeByPathRef' | 'openFiles' | 'getOpenFileFolder' | 'selectedFile' | 'editorTabsScrollRef' |
  'editorTabsOverflow' | 'fileContent' | 'fileLoading' | 'fileError' | 'editorDocumentPath' | 'filePositionKey' |
  'draftContent' | 'setDraftContent' | 'isSaving' | 'diagramEditorRef' | 'confirmDiscardOpen' |
  'setConfirmDiscardOpen' | 'editorViewRef' | 'editorWrapperRef' | 'setEditorViewReadyNonce' | 'isSymbolsOpen' |
  'setIsSymbolsOpen' | 'mdPreviewFindOpen' | 'setMdPreviewFindOpen' | 'mdPreviewFindFocusNonce' |
  'mdPreviewOutlineOpen' | 'setMdPreviewOutlineOpen' | 'mdPreviewContainerRef' | 'focusMdPreviewContainer' |
  'lineSelection' | 'fileEditorKeymap'> &
Pick<ReturnType<typeof useFileComments>,
  'markdownPreviewRef' | 'lineNumbersConfig'> &
Pick<ReturnType<typeof useFileOpening>,
  'handleSelectFile'> &
Pick<ReturnType<typeof useFileClosing>,
  'discardAndContinue' | 'saveAndContinue' | 'handleCloseFile'> &
Pick<ReturnType<typeof useFileKinds>,
  'shouldMaskEditorForPendingNavigation' | 'canEdit' | 'isMarkdown' | 'isJson' | 'isHtml' | 'isDrawio' |
  'suggestExcalidrawExtension' | 'canUseShikiFileView'> &
Pick<ReturnType<typeof useFilePreviewModes>,
  'getMdViewMode' | 'handleDiagramChange' | 'diagramEditorXml'> &
Pick<ReturnType<typeof useFileNavigation>,
  'nudgeEditorSelectionAboveKeyboard'> &
Pick<ReturnType<typeof useFileEditorExtensions>,
  'previewFontStyle' | 'applyGitBaseline' | 'editorExtensions'> &
Pick<ReturnType<typeof useFileAssets>,
  'htmlPreviewUnreachable' | 'htmlPreview' | 'htmlPreviewFrameRef' | 'htmlPreviewAnnotation' |
  'annotateWhenLoadedRef' | 'isPdfAssetAuthLoading'> &
Pick<ReturnType<typeof useArtifactPreview>,
  'artifactPreview' | 'fileLoadingState' | 'renderFileErrorState'> &
Pick<ReturnType<typeof useFilePreviewRendering>,
  'blockWidgets' | 'mainViewVirtualizer' | 'showCanvas' | 'restoreMainCodeScroll' | 'setMainPreviewScroller' |
  'setMainMarkdownScroller' | 'markdownDocumentAssets' | 'isLargeFile' | 'renderShikiFileView'> &
Pick<ReturnType<typeof useFileToolbar>,
  'renderFileToolbar'> &
Pick<ReturnType<typeof useFileCanvas>,
  'canvasInFullscreen' | 'canvasElement' | 'openExcalidrawExtensionCard' | 'wholeFileCommentPanel'>) {
  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
    >
      <Dialog open={confirmDiscardOpen} onOpenChange={(open) => {
        // Intentionally no "cancel" action. Keep dialog modal.
        if (!open) {
          setConfirmDiscardOpen(true);
        }
      }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('filesView.unsaved.title')}</DialogTitle>
            <DialogDescription>
              {t('filesView.unsaved.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void saveAndContinue()}
              disabled={isSaving}
              className="border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)] hover:bg-[var(--status-success)]/20"
            >
              {t('filesView.unsaved.saveChanges')}
            </Button>
            <Button variant="destructive" onClick={discardAndContinue}>{t('filesView.unsaved.discard')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className={cn('flex flex-col flex-shrink-0', showEditorTabsRow && 'border-b border-edge-muted')}>
        {/* Row 1: Tabs */}
        {showEditorTabsRow ? (
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
        ) : null}

        {/* Row 2: Docked editor toolbar, 36px with 24px buttons: the same band
            the context panel's file tree draws beside it with its search
            field and actions, so the two read as one strip. */}
        {selectedFile ? (
          <div className="flex h-9 min-w-0 shrink-0 items-center border-t border-edge-muted px-2">
            {renderFileToolbar({ layout: 'docked' })}
          </div>
        ) : null}

      </div>

      {!(mode === 'full' && isFullscreen) && wholeFileCommentPanel}
      {suggestExcalidrawExtension ? (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge-muted bg-[var(--surface-muted)] px-3 py-1.5 typography-ui text-muted-foreground">
          <Icon name="information" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('filesView.excalidraw.installHint')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="xs" variant="outline" onClick={openExcalidrawExtensionCard}>
                {t('filesView.excalidraw.installAction')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.files.excalidrawSettings')}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay ref={setMainPreviewScroller} outerClassName="h-full min-w-0" className={cn('h-full min-w-0', isLargeFile && '[overflow-anchor:none]')}>
          {!selectedFile ? (
            <div className="p-3 typography-ui text-muted-foreground">{t('filesView.editor.pickFileFromTree')}</div>
          ) : (fileLoading || isPdfAssetAuthLoading) ? (
            fileLoadingState
          ) : fileError ? (
            renderFileErrorState(selectedFile)
          ) : showCanvas ? (
            // Ahead of the built-in previews: a binary editor may claim an image or PDF.
            // Shown fullscreen instead while the overlay is open: one canvas instance.
            canvasInFullscreen ? <div className="h-full" /> : canvasElement
          ) : artifactPreview ? (
            artifactPreview
          ) : selectedFile && isDrawio && drawioViewMode === 'preview' ? (
            <div className="h-full overflow-hidden" style={{ minHeight: '400px' }}>
              <DiagramEditor
                key={`${editorDocumentPath ?? selectedFile.path}:${drawioRemountNonce}`}
                ref={diagramEditorRef}
                xml={diagramEditorXml}
                onChange={handleDiagramChange}
              />
            </div>
          ) : selectedFile && isJson && jsonViewMode === 'tree' ? (
            <ErrorBoundary
              fallback={
                <div className="rounded-md bg-destructive/10 px-3 py-2">
                  <div className="mb-1 font-medium text-destructive">{t('filesView.error.jsonViewerUnavailable')}</div>
                  <div className="text-sm text-muted-foreground">
                    {t('filesView.error.switchToTextMode')}
                  </div>
                </div>
              }
            >
              <div className="h-full">
                <JsonTreeView
                  className="h-full"
                  jsonString={fileContent}
                  // Config files under a .json name (tsconfig, opencode.json) carry
                  // comments and trailing commas; the editor's check accepts them too.
                  format="jsonc"
                  maxHeight="100%"
                  initiallyExpandedDepth={2}
                />
              </div>
            </ErrorBoundary>
          ) : selectedFile && isMarkdown && getMdViewMode() === 'preview' ? (
            <div className="relative h-full min-h-0">
              <div
                className="oc-file-preview overlay-scrollbar-target overlay-scrollbar-container h-full overflow-auto p-3 outline-none"
                // Focusable so Cmd/Ctrl+F reaches the find bar: the keybind only
                // fires when the event target sits inside this container, and a
                // plain div never holds focus. -1 keeps it out of the tab order.
                tabIndex={-1}
                onMouseDown={focusMdPreviewContainer}
                ref={setMainMarkdownScroller}
              >
                <FilePreviewCommentMenu
                  containerRef={markdownPreviewRef}
                  filePath={selectedFile.path}
                  fileContent={fileContent}
                />
                {fileContent.length > 500 * 1024 && (
                  <div className="mb-3 rounded-md bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                    {t('filesView.warning.largeFilePreviewLimited', { sizeKb: Math.round(fileContent.length / 1024) })}
                  </div>
                )}
                <ErrorBoundary
                  fallback={
                    <div className="rounded-md bg-destructive/10 px-3 py-2">
                      <div className="mb-1 font-medium text-destructive">{t('filesView.error.previewUnavailable')}</div>
                      <div className="text-sm text-muted-foreground">
                        {t('filesView.error.switchToEditMode')}
                      </div>
                    </div>
                  }
                >
                  <div style={previewFontStyle}>
                    <SimpleMarkdownRenderer
                      content={fileContent}
                      documentAssets={markdownDocumentAssets}
                      className="typography-markdown-body"
                      frontmatter="properties"
                      enableFileReferences={false}
                      allowRawHtml
                      svgFences
                      windowed
                      tableWidthScope={selectedFile.path}
                    />
                  </div>
                </ErrorBoundary>
              </div>
              <OverlayScrollbar containerRef={mdPreviewContainerRef} />
              {!isFullscreen && (
                <>
                  <MarkdownPreviewSearch
                    containerRef={mdPreviewContainerRef}
                    open={mdPreviewFindOpen}
                    onOpenChange={setMdPreviewFindOpen}
                    focusNonce={mdPreviewFindFocusNonce}
                  />
                  <MarkdownPreviewOutline
                    containerRef={mdPreviewContainerRef}
                    open={mdPreviewOutlineOpen}
                    onOpenChange={setMdPreviewOutlineOpen}
                  />
                </>
              )}
            </div>
          ) : selectedFile && isHtml && htmlViewMode === 'preview' && htmlPreviewUnreachable ? (
            <ContentState
              icon={<FileTypeIcon filePath={selectedFile.path} className="size-10" />}
              title={t('filesView.editor.htmlPreviewRelayUnavailable')}
              actions={(
                // For this file only: leaving this message is not choosing code
                // as the default, which would follow the user to a direct host.
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        htmlViewModeByPathRef.current[selectedFile.path] = 'edit';
                        setHtmlViewMode('edit');
                      }}
                    >
                      {t('filesView.editor.htmlPreviewShowCode')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>{t('contextTooltips.files.showCodeForFile')}</TooltipContent>
                </Tooltip>
              )}
            />
          ) : selectedFile && isHtml && htmlViewMode === 'preview' ? (
            !runtime.isVSCode && htmlPreview.status === 'loading' ? (
              <div className="flex h-full items-center justify-center text-muted-foreground typography-ui-label">
                {t('common.loading')}
              </div>
            ) : (
            <div className="h-full overflow-hidden">
              {/* No allow-same-origin: the page is untrusted and must not run as the app. */}
              <iframe
                ref={htmlPreviewFrameRef}
                onLoad={() => {
                  if (annotateWhenLoadedRef.current !== selectedFile.path) return;
                  annotateWhenLoadedRef.current = null;
                  if (!htmlPreviewAnnotation.isAnnotating) htmlPreviewAnnotation.toggle();
                }}
                src={htmlPreview.status === 'ready' ? htmlPreview.url : undefined}
                srcDoc={runtime.isVSCode ? (() => {
                  const basePath = selectedFile.path.substring(0, selectedFile.path.lastIndexOf('/') + 1);
                  if (!basePath) return fileContent;
                  return fileContent.replace(/<head([^>]*)>/i, `<head$1><base href="${basePath}">`);
                })() : undefined}
                className="w-full h-full border-none"
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                title={t('filesView.editor.htmlPreviewTitle')}
              />
            </div>
            )
          ) : selectedFile && canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent, mainViewVirtualizer, restoreMainCodeScroll)
          ) : (
            <div
              className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}
              ref={editorWrapperRef}
            >
              {!isFullscreen && (
                <DocumentSymbolsPanel open={isSymbolsOpen} onOpenChange={setIsSymbolsOpen} viewRef={editorViewRef} />
              )}
              <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
                <DetachableEditorMarker />
                <FilePositionEditor
                  key={filePositionKey}
                  positionKey={filePositionKey}
                  detached={!visible}
                  value={draftContent}
                  onChange={setDraftContent}
                  readOnly={!canEdit}
                  vimMode={fileEditorKeymap === 'vim'}
                  extensions={editorExtensions}
                  className={cn('h-full', isMobile && 'oc-compact-search')}
                  blockWidgets={blockWidgets}
                  onViewReady={(view) => {
                    editorViewRef.current = view;
                    applyGitBaseline(view);
                    setEditorViewReadyNonce((value) => value + 1);
                    window.requestAnimationFrame(() => {
                      nudgeEditorSelectionAboveKeyboard(view);
                    });
                  }}
                  onViewDestroy={() => {
                    if (editorViewRef.current) {
                      editorViewRef.current = null;
                    }
                    setEditorViewReadyNonce((value) => value + 1);
                  }}
                  enableSearch
                  searchOpen={isSearchOpen}
                  onSearchOpenChange={setIsSearchOpen}
                  highlightLines={lineSelection
                    ? {
                      start: Math.min(lineSelection.start, lineSelection.end),
                      end: Math.max(lineSelection.start, lineSelection.end),
                    }
                    : undefined}
                  lineNumbersConfig={lineNumbersConfig}
                />
              </div>
              {shouldMaskEditorForPendingNavigation && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
                  <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {t('filesView.state.openingFileAtChange')}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );
}
