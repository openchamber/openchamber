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
import { type FilesViewOptions } from './fileViewTypes';
import { type useFileKinds } from './useFileKinds';
import { type useFilePreviewModes, type useFileViewModes } from './useFilePreviewModes';
import { type useFileEditorExtensions, type useFileEditor } from './useFileEditorExtensions';
import { type useFileAssets } from './useFileAssets';
import { type useArtifactPreview } from './useArtifactPreview';
import { type useFilePreviewRendering } from './useFilePreviewRendering';
import { type useFileToolbar } from './useFileToolbar';
import { type useFileCanvas, type useFileFullscreen } from './useFileCanvas';
import { type useFileDraft } from './useFileSaving';
import { type useFileComments } from './useFileComments';
import { type useFileDocument } from './useFileDocument';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type useFileMobileKeyboard } from './useFileMobileKeyboard';
import { type useFileNavigationMask } from './useFileNavigation';
import { type useFileTabs } from './useFileTabs';
import { useI18n } from '@/lib/i18n';

export function renderFullscreenFileViewer({ artifacts, draft, editor, fileAssets, fileCanvas, fileComments, fileDocument, fileEditorExtensions, fileKinds, filePreviewModes, filePreviewRendering, fileToolbar, fullscreen, markdownPreview, mobileKeyboard, navigationMask, tabs, viewModes, isMobile, mode, t }: {
  artifacts: Pick<ReturnType<typeof useArtifactPreview>, 'artifactPreview' | 'fileLoadingState' | 'renderFileErrorState'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent' | 'setDraftContent'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'fileEditorKeymap' | 'isSymbolsOpen' | 'setIsSymbolsOpen'>;
  fileAssets: Pick<ReturnType<typeof useFileAssets>, 'isPdfAssetAuthLoading'>;
  fileCanvas: Pick<ReturnType<typeof useFileCanvas>, 'canvasElement'>;
  fileComments: Pick<ReturnType<typeof useFileComments>, 'wholeFileCommentPanel'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent' | 'fileError' | 'fileLoading' | 'filePositionKey'>;
  fileEditorExtensions: Pick<ReturnType<typeof useFileEditorExtensions>, 'applyGitBaseline' | 'editorExtensions' | 'previewFontStyle'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canEdit' | 'canUseShikiFileView' | 'isMarkdown'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'getMdViewMode'>;
  filePreviewRendering: Pick<ReturnType<typeof useFilePreviewRendering>, 'fullscreenViewVirtualizer' | 'isLargeFile' | 'markdownDocumentAssets' | 'renderShikiFileView' | 'restoreFullscreenCodeScroll' | 'setFullscreenMarkdownScroller' | 'setFullscreenPreviewScroller' | 'showCanvas'>;
  fileToolbar: Pick<ReturnType<typeof useFileToolbar>, 'renderFileToolbar'>;
  fullscreen: Pick<ReturnType<typeof useFileFullscreen>, 'isFullscreen'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'focusMdPreviewContainer' | 'mdFullscreenPreviewContainerRef' | 'mdPreviewFindFocusNonce' | 'mdPreviewFindOpen' | 'mdPreviewOutlineOpen' | 'setMdPreviewFindOpen' | 'setMdPreviewOutlineOpen'>;
  mobileKeyboard: Pick<ReturnType<typeof useFileMobileKeyboard>, 'nudgeEditorSelectionAboveKeyboard'>;
  navigationMask: Pick<ReturnType<typeof useFileNavigationMask>, 'shouldMaskEditorForPendingNavigation'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'textViewMode'>;
  isMobile: boolean;
  mode: FilesViewOptions['mode'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { artifactPreview, fileLoadingState, renderFileErrorState } = artifacts;
  const { draftContent, setDraftContent } = draft;
  const { editorViewRef, fileEditorKeymap, isSymbolsOpen, setIsSymbolsOpen } = editor;
  const { isPdfAssetAuthLoading } = fileAssets;
  const { canvasElement } = fileCanvas;
  const { wholeFileCommentPanel } = fileComments;
  const { fileContent, fileError, fileLoading, filePositionKey } = fileDocument;
  const { applyGitBaseline, editorExtensions, previewFontStyle } = fileEditorExtensions;
  const { canEdit, canUseShikiFileView, isMarkdown } = fileKinds;
  const { getMdViewMode } = filePreviewModes;
  const { fullscreenViewVirtualizer, isLargeFile, markdownDocumentAssets, renderShikiFileView, restoreFullscreenCodeScroll, setFullscreenMarkdownScroller, setFullscreenPreviewScroller, showCanvas } = filePreviewRendering;
  const { renderFileToolbar } = fileToolbar;
  const { isFullscreen } = fullscreen;
  const { focusMdPreviewContainer, mdFullscreenPreviewContainerRef, mdPreviewFindFocusNonce, mdPreviewFindOpen, mdPreviewOutlineOpen, setMdPreviewFindOpen, setMdPreviewOutlineOpen } = markdownPreview;
  const { nudgeEditorSelectionAboveKeyboard } = mobileKeyboard;
  const { shouldMaskEditorForPendingNavigation } = navigationMask;
  const { selectedFile } = tabs;
  const { textViewMode } = viewModes;

  return mode === 'full' && isFullscreen && selectedFile && (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {wholeFileCommentPanel}
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
