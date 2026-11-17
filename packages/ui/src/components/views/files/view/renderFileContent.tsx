import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { DiagramEditor } from '@/components/diagram';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { type useFileKinds } from './useFileKinds';
import { type useFilePreviewModes, type useFileDiagram, type useFileViewModes } from './useFilePreviewModes';
import { type useFileAssets } from './useFileAssets';
import { type useArtifactPreview } from './useArtifactPreview';
import { type useFilePreviewRendering } from './useFilePreviewRendering';
import { type useFileCanvas } from './useFileCanvas';
import { type useFileDraft } from './useFileSaving';
import { type useFileDocument } from './useFileDocument';
import { type useFileTabs } from './useFileTabs';
import { useI18n } from '@/lib/i18n';
import type React from 'react';

export function renderFileContent({ artifacts, diagram, draft, fileAssets, fileCanvas, fileDocument, fileKinds, filePreviewModes, filePreviewRendering, tabs, viewModes, htmlContent, htmlUnavailableContent, markdownContent, sourceEditor, t }: {
  artifacts: Pick<ReturnType<typeof useArtifactPreview>, 'artifactPreview' | 'fileLoadingState' | 'renderFileErrorState'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramEditorRef' | 'drawioRemountNonce'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent'>;
  fileAssets: Pick<ReturnType<typeof useFileAssets>, 'htmlPreviewUnreachable' | 'isPdfAssetAuthLoading'>;
  fileCanvas: Pick<ReturnType<typeof useFileCanvas>, 'canvasElement' | 'canvasInFullscreen'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'editorDocumentPath' | 'fileContent' | 'fileError' | 'fileLoading'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canUseShikiFileView' | 'isDrawio' | 'isHtml' | 'isJson' | 'isMarkdown'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'diagramEditorXml' | 'getMdViewMode' | 'handleDiagramChange'>;
  filePreviewRendering: Pick<ReturnType<typeof useFilePreviewRendering>, 'mainViewVirtualizer' | 'renderShikiFileView' | 'restoreMainCodeScroll' | 'showCanvas'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'drawioViewMode' | 'htmlViewMode' | 'jsonViewMode' | 'textViewMode'>;
  htmlContent: () => React.ReactNode;
  htmlUnavailableContent: () => React.ReactNode;
  markdownContent: () => React.ReactNode;
  sourceEditor: () => React.ReactNode;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { artifactPreview, fileLoadingState, renderFileErrorState } = artifacts;
  const { diagramEditorRef, drawioRemountNonce } = diagram;
  const { draftContent } = draft;
  const { htmlPreviewUnreachable, isPdfAssetAuthLoading } = fileAssets;
  const { canvasElement, canvasInFullscreen } = fileCanvas;
  const { editorDocumentPath, fileContent, fileError, fileLoading } = fileDocument;
  const { canUseShikiFileView, isDrawio, isHtml, isJson, isMarkdown } = fileKinds;
  const { diagramEditorXml, getMdViewMode, handleDiagramChange } = filePreviewModes;
  const { mainViewVirtualizer, renderShikiFileView, restoreMainCodeScroll, showCanvas } = filePreviewRendering;
  const { selectedFile } = tabs;
  const { drawioViewMode, htmlViewMode, jsonViewMode, textViewMode } = viewModes;
  return (
!selectedFile ? (
            <div className="p-3 typography-ui text-muted-foreground">{t('filesView.editor.pickFileFromTree')}</div>
          ) : (fileLoading || isPdfAssetAuthLoading) ? (
            fileLoadingState
          ) : fileError ? (
            renderFileErrorState(selectedFile)
          ) : showCanvas ? (
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
                  format="jsonc"
                  maxHeight="100%"
                  initiallyExpandedDepth={2}
                />
              </div>
            </ErrorBoundary>
          ) : selectedFile && isMarkdown && getMdViewMode() === 'preview' ? (
            markdownContent()
          ) : selectedFile && isHtml && htmlViewMode === 'preview' && htmlPreviewUnreachable ? (
            htmlUnavailableContent()
          ) : selectedFile && isHtml && htmlViewMode === 'preview' ? (
            htmlContent()
          ) : selectedFile && canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent, mainViewVirtualizer, restoreMainCodeScroll)
          ) : (
            sourceEditor()
          )
  );
}
