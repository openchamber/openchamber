import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { MarkdownPreviewSearch } from '../../MarkdownPreviewSearch';
import { MarkdownPreviewOutline } from '../../MarkdownPreviewOutline';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { FilePreviewCommentMenu } from '@/components/comments';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { type useFileComments } from './useFileComments';
import { type useFileEditorExtensions } from './useFileEditorExtensions';
import { type useFilePreviewRendering } from './useFilePreviewRendering';
import { type useFileDocument } from './useFileDocument';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type useFileTabs } from './useFileTabs';
import { useI18n } from '@/lib/i18n';

export function renderFileMarkdownPreview({ fileComments, fileDocument, fileEditorExtensions, filePreviewRendering, markdownPreview, tabs, t }: {
  fileComments: Pick<ReturnType<typeof useFileComments>, 'markdownPreviewRef'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContent'>;
  fileEditorExtensions: Pick<ReturnType<typeof useFileEditorExtensions>, 'previewFontStyle'>;
  filePreviewRendering: Pick<ReturnType<typeof useFilePreviewRendering>, 'markdownDocumentAssets' | 'setMainMarkdownScroller'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'focusMdPreviewContainer' | 'mdPreviewContainerRef' | 'mdPreviewFindFocusNonce' | 'mdPreviewFindOpen' | 'mdPreviewOutlineOpen' | 'setMdPreviewFindOpen' | 'setMdPreviewOutlineOpen'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { markdownPreviewRef } = fileComments;
  const { fileContent } = fileDocument;
  const { previewFontStyle } = fileEditorExtensions;
  const { markdownDocumentAssets, setMainMarkdownScroller } = filePreviewRendering;
  const { focusMdPreviewContainer, mdPreviewContainerRef, mdPreviewFindFocusNonce, mdPreviewFindOpen, mdPreviewOutlineOpen, setMdPreviewFindOpen, setMdPreviewOutlineOpen } = markdownPreview;
  const { selectedFile } = tabs;
  if (!selectedFile) return null;
  return (
            <div className="relative h-full min-h-0">
              <div
                className="oc-file-preview overlay-scrollbar-target overlay-scrollbar-container h-full overflow-auto p-3 outline-none"
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
            </div>
  );
}
