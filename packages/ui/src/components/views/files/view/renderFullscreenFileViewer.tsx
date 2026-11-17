import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DocumentSymbolsPanel } from '../../DocumentSymbolsPanel';
import { MarkdownPreviewSearch } from '../../MarkdownPreviewSearch';
import { MarkdownPreviewOutline } from '../../MarkdownPreviewOutline';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { cn } from '@/lib/utils';
import { FilePreviewCommentMenu } from '@/components/comments';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Icon } from '@/components/icon/Icon';
import { FilePositionEditor } from './FilePositionEditor';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileKinds } from './useFileKinds';
import type { useFilePreviewModes } from './useFilePreviewModes';
import type { useFileNavigation } from './useFileNavigation';
import type { useFileEditorExtensions } from './useFileEditorExtensions';
import type { useFileAssets } from './useFileAssets';
import type { useArtifactPreview } from './useArtifactPreview';
import type { useFilePreviewRendering } from './useFilePreviewRendering';
import type { useFileToolbar } from './useFileToolbar';
import type { useFileCanvas } from './useFileCanvas';

export function renderFullscreenFileViewer({
  mode, t, isMobile, isFullscreen, textViewMode, selectedFile, fileContent, fileLoading, fileError, filePositionKey,
  draftContent, setDraftContent, editorViewRef, isSymbolsOpen, setIsSymbolsOpen, mdPreviewFindOpen,
  setMdPreviewFindOpen, mdPreviewFindFocusNonce, mdPreviewOutlineOpen, setMdPreviewOutlineOpen,
  focusMdPreviewContainer, mdFullscreenPreviewContainerRef, fileEditorKeymap, shouldMaskEditorForPendingNavigation,
  canEdit, isMarkdown, canUseShikiFileView, getMdViewMode, nudgeEditorSelectionAboveKeyboard, previewFontStyle,
  applyGitBaseline, editorExtensions, isPdfAssetAuthLoading, artifactPreview, fileLoadingState,
  renderFileErrorState, fullscreenViewVirtualizer, showCanvas, restoreFullscreenCodeScroll,
  setFullscreenPreviewScroller, setFullscreenMarkdownScroller, markdownDocumentAssets, isLargeFile,
  renderShikiFileView, renderFileToolbar, canvasElement, wholeFileCommentPanel,
}: Pick<FilesViewOptions, 'mode'> &
Pick<ReturnType<typeof useFilesViewState>,
  't' | 'isMobile' | 'isFullscreen' | 'textViewMode' | 'selectedFile' | 'fileContent' | 'fileLoading' |
  'fileError' | 'filePositionKey' | 'draftContent' | 'setDraftContent' | 'editorViewRef' | 'isSymbolsOpen' |
  'setIsSymbolsOpen' | 'mdPreviewFindOpen' | 'setMdPreviewFindOpen' | 'mdPreviewFindFocusNonce' |
  'mdPreviewOutlineOpen' | 'setMdPreviewOutlineOpen' | 'focusMdPreviewContainer' |
  'mdFullscreenPreviewContainerRef' | 'fileEditorKeymap'> &
Pick<ReturnType<typeof useFileKinds>,
  'shouldMaskEditorForPendingNavigation' | 'canEdit' | 'isMarkdown' | 'canUseShikiFileView'> &
Pick<ReturnType<typeof useFilePreviewModes>,
  'getMdViewMode'> &
Pick<ReturnType<typeof useFileNavigation>,
  'nudgeEditorSelectionAboveKeyboard'> &
Pick<ReturnType<typeof useFileEditorExtensions>,
  'previewFontStyle' | 'applyGitBaseline' | 'editorExtensions'> &
Pick<ReturnType<typeof useFileAssets>,
  'isPdfAssetAuthLoading'> &
Pick<ReturnType<typeof useArtifactPreview>,
  'artifactPreview' | 'fileLoadingState' | 'renderFileErrorState'> &
Pick<ReturnType<typeof useFilePreviewRendering>,
  'fullscreenViewVirtualizer' | 'showCanvas' | 'restoreFullscreenCodeScroll' | 'setFullscreenPreviewScroller' |
  'setFullscreenMarkdownScroller' | 'markdownDocumentAssets' | 'isLargeFile' | 'renderShikiFileView'> &
Pick<ReturnType<typeof useFileToolbar>,
  'renderFileToolbar'> &
Pick<ReturnType<typeof useFileCanvas>,
  'canvasElement' | 'wholeFileCommentPanel'>) {
  // Fullscreen file viewer overlay
  return mode === 'full' && isFullscreen && selectedFile && (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {wholeFileCommentPanel}
      {/* Fullscreen content */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <div className="absolute inset-e-4 top-4 z-30">
          {renderFileToolbar({ exitFullscreenOnly: true })}
        </div>
        <ScrollableOverlay ref={setFullscreenPreviewScroller} outerClassName="h-full min-w-0" className={cn('h-full min-w-0', isLargeFile && '[overflow-anchor:none]')}>
          {(fileLoading || isPdfAssetAuthLoading) ? (
            fileLoadingState
          ) : fileError ? (
            renderFileErrorState(selectedFile)
          ) : showCanvas ? (
            canvasElement
          ) : artifactPreview ? (
            artifactPreview
          ) : isMarkdown && getMdViewMode() === 'preview' ? (
            // The find bar is a sibling of the scroll container, never a child:
            // inside it, its own "1/3" and "No matches" text would be walked and
            // highlighted by the search it drives.
            <div className="relative h-full min-h-0">
            <div
              className="oc-file-preview overlay-scrollbar-target overlay-scrollbar-container h-full overflow-auto p-4 outline-none"
              tabIndex={-1}
              onMouseDown={focusMdPreviewContainer}
              ref={setFullscreenMarkdownScroller}
            >
              {selectedFile ? (
                <FilePreviewCommentMenu
                  containerRef={mdFullscreenPreviewContainerRef}
                  filePath={selectedFile.path}
                  fileContent={fileContent}
                />
              ) : null}
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
              <OverlayScrollbar containerRef={mdFullscreenPreviewContainerRef} />
              <MarkdownPreviewSearch
                containerRef={mdFullscreenPreviewContainerRef}
                open={mdPreviewFindOpen}
                onOpenChange={setMdPreviewFindOpen}
                focusNonce={mdPreviewFindFocusNonce}
                className="inset-e-4 top-16"
              />
              <MarkdownPreviewOutline
                containerRef={mdFullscreenPreviewContainerRef}
                open={mdPreviewOutlineOpen}
                onOpenChange={setMdPreviewOutlineOpen}
                className="inset-s-4 top-16"
              />
            </div>
          ) : canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent, fullscreenViewVirtualizer, restoreFullscreenCodeScroll)
          ) : (
            <div className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}>
              <DocumentSymbolsPanel open={isSymbolsOpen} onOpenChange={setIsSymbolsOpen} viewRef={editorViewRef} />
              <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
              <FilePositionEditor
                key={`${filePositionKey}:fullscreen`}
                positionKey={`${filePositionKey}:fullscreen`}
                value={draftContent}
                onChange={setDraftContent}
                readOnly={!canEdit}
                vimMode={fileEditorKeymap === 'vim'}
                extensions={editorExtensions}
                className={cn('h-full', isMobile && 'oc-compact-search')}
                onViewReady={(view) => {
                  editorViewRef.current = view;
                  applyGitBaseline(view);
                  window.requestAnimationFrame(() => {
                    nudgeEditorSelectionAboveKeyboard(view);
                  });
                }}
                onViewDestroy={() => {
                  if (editorViewRef.current) {
                    editorViewRef.current = null;
                  }
                }}
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
