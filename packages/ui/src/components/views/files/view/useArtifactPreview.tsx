import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { isDelimitedTableFile, isArchiveFile, isDataFile, isOfficePreviewFile } from '@/lib/toolHelpers';
import { MAX_OFFICE_PREVIEW_BYTES } from '@/lib/fileOpenLimits';
import { BinaryArtifact } from '../previews/BinaryArtifact';
import { ArchiveArtifact } from '../previews/ArchiveArtifact';
import { NotebookArtifact } from '../previews/NotebookArtifact';
import { PdfArtifact } from '../previews/PdfArtifact';
import { FontArtifact } from '../previews/FontArtifact';
import { ImageArtifact } from '../previews/ImageArtifact';
import { MediaArtifact } from '../previews/MediaArtifact';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { Icon } from '@/components/icon/Icon';
import type { FileNode } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileFreshness } from './useFileFreshness';
import type { useFileKinds } from './useFileKinds';
import type { useFileAssets } from './useFileAssets';
import { TableArtifact, DataFileArtifact, OfficeArtifact } from './LazyFileArtifacts';

export function useArtifactPreview({
  t, files, suppressFileLoadingIndicator, mermaidViewMode, tableViewMode, artifactSize, selectedFile,
  selectedFileIsOutsideWorkspace, fileContent, fileLoading, fileError, draftContent, setDraftContent,
  fileContentRevision, reloadSelectedFile, isSelectedImage, isSvgSource, isSelectedPdf, isSelectedVideo,
  isSelectedMedia, isSelectedFont, isUnsupportedBinary, imageNeighbors, canEdit, isMermaid, isTable, isNotebook,
  assetAuthErrorFallback, rawAsset, isPdfAssetAuthLoading, imageSrc, pdfSrc, downloadButton, maxDataBytes,
  loadOfficeBytes, loadDataBytes, saveOfficeBytes, binaryFileActions,
}: Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'suppressFileLoadingIndicator' | 'mermaidViewMode' | 'tableViewMode' | 'artifactSize' |
  'selectedFile' | 'selectedFileIsOutsideWorkspace' | 'fileContent' | 'fileLoading' | 'fileError' |
  'draftContent' | 'setDraftContent' | 'fileContentRevision'> &
Pick<ReturnType<typeof useFileFreshness>,
  'reloadSelectedFile'> &
Pick<ReturnType<typeof useFileKinds>,
  'isSelectedImage' | 'isSvgSource' | 'isSelectedPdf' | 'isSelectedVideo' | 'isSelectedMedia' | 'isSelectedFont' |
  'isUnsupportedBinary' | 'imageNeighbors' | 'canEdit' | 'isMermaid' | 'isTable' | 'isNotebook'> &
Pick<ReturnType<typeof useFileAssets>,
  'assetAuthErrorFallback' | 'rawAsset' | 'isPdfAssetAuthLoading' | 'imageSrc' | 'pdfSrc' | 'downloadButton' |
  'maxDataBytes' | 'loadOfficeBytes' | 'loadDataBytes' | 'saveOfficeBytes' | 'binaryFileActions'>) {
  // Keyed per file, so the next file gets a fresh boundary and not the last
  // file's failure.
  const previewBoundary = (key: string, preview: React.ReactNode) => (
    <ErrorBoundary key={key} fallback={<ContentState title={t('filesView.error.previewUnavailable')} />}>
      <React.Suspense fallback={<ContentLoadingState label={t('filesView.artifact.state.loading')} />}>
        {preview}
      </React.Suspense>
    </ErrorBoundary>
  );

  // Everything shown as an artifact rather than as editable text. One place
  // for both the docked and the fullscreen viewer, so they cannot drift.
  const renderArtifactPreview = (file: FileNode): React.ReactNode => {
    if (isSelectedImage && !isSvgSource) {
      return (
        <ImageArtifact
          src={imageSrc}
          name={file.name}
          sizeBytes={artifactSize}
          neighbors={imageNeighbors}
          onRetry={reloadSelectedFile}
          download={downloadButton}
        />
      );
    }
    if (isSelectedPdf) {
      return <PdfArtifact src={pdfSrc} name={file.name} sizeBytes={artifactSize} download={downloadButton} />;
    }
    if (isSelectedMedia) {
      return (
        <MediaArtifact
          kind={isSelectedVideo ? 'video' : 'audio'}
          src={pdfSrc}
          renewSrc={rawAsset.renew}
          name={file.name}
          sizeBytes={artifactSize}
          download={downloadButton}
        />
      );
    }
    if (isSelectedFont) {
      return <FontArtifact src={pdfSrc} name={file.name} sizeBytes={artifactSize} />;
    }
    if (isUnsupportedBinary) {
      const officeTooLarge = artifactSize !== null && artifactSize > MAX_OFFICE_PREVIEW_BYTES;
      if (isArchiveFile(file.path) && !officeTooLarge) {
        return <ArchiveArtifact key={`${file.path}:${fileContentRevision}`} name={file.name} path={file.path} sizeBytes={artifactSize} loadBytes={loadOfficeBytes} actions={binaryFileActions} />;
      }
      if ((isDataFile(file.path) || isDelimitedTableFile(file.path)) && !(artifactSize !== null && artifactSize > maxDataBytes)) {
        return previewBoundary(
          `${file.path}:${fileContentRevision}`,
          <DataFileArtifact name={file.name} path={file.path} sizeBytes={artifactSize} loadBytes={loadDataBytes} actions={binaryFileActions} />,
        );
      }
      if (isOfficePreviewFile(file.path) && !officeTooLarge) {
        return previewBoundary(
          `${file.path}:${fileContentRevision}`,
          <OfficeArtifact
            name={file.name}
            path={file.path}
            sizeBytes={artifactSize}
            loadBytes={loadOfficeBytes}
            actions={binaryFileActions}
            onSave={files.uploadFile && !selectedFileIsOutsideWorkspace ? saveOfficeBytes : undefined}
          />,
        );
      }
      return (
        <BinaryArtifact
          name={file.name}
          path={file.path}
          sizeBytes={artifactSize}
          download={binaryFileActions}
          description={isOfficePreviewFile(file.path) || isArchiveFile(file.path) || isDataFile(file.path) || isDelimitedTableFile(file.path) ? t('filesView.artifact.office.tooLarge') : undefined}
        />
      );
    }
    if (isNotebook && tableViewMode === 'table') {
      return <NotebookArtifact content={fileContent} sizeBytes={artifactSize} />;
    }
    if (isTable && tableViewMode === 'table') {
      return previewBoundary(
        file.path,
        <TableArtifact
          path={file.path}
          content={canEdit ? draftContent : fileContent}
          sizeBytes={artifactSize}
          onContentChange={canEdit ? setDraftContent : undefined}
        />,
      );
    }
    if (isMermaid && mermaidViewMode === 'preview') {
      return (
        // The whole panel is the diagram: the same fill-the-container styling
        // the fullscreen mermaid dialog uses, not the chat block's capped height.
        <div className="h-full min-h-0 overflow-hidden">
          <ErrorBoundary
            fallback={
              <div className="m-3 rounded-md bg-destructive/10 px-3 py-2">
                <div className="mb-1 font-medium text-destructive">{t('filesView.error.previewUnavailable')}</div>
                <div className="text-sm text-muted-foreground">{t('filesView.error.switchToEditMode')}</div>
              </div>
            }
          >
            <SimpleMarkdownRenderer
              content={`\`\`\`mermaid\n${fileContent}\n\`\`\``}
              className="markdown-mermaid-fullscreen h-full"
              enableFileReferences={false}
            />
          </ErrorBoundary>
        </div>
      );
    }
    return null;
  };
  const artifactPreview = selectedFile && !fileLoading && !isPdfAssetAuthLoading && !fileError
    ? renderArtifactPreview(selectedFile)
    : null;

  const fileLoadingState = suppressFileLoadingIndicator
    ? <div className="h-full" />
    : <ContentLoadingState label={t('filesView.artifact.state.loading')} />;
  const renderFileErrorState = (file: FileNode) => (
    <ContentState
      icon={<Icon name="error-warning" className="size-10 text-[color:var(--status-error)]" />}
      title={t('filesView.artifact.state.readFailed', { name: file.name })}
      // The generic fallback adds nothing to the title; a server's reason does.
      description={fileError && fileError !== assetAuthErrorFallback ? fileError : undefined}
      actions={(
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="sm" onClick={reloadSelectedFile}>
              <Icon name="refresh" className="me-2 size-4" />
              {t('filesView.artifact.state.retry')}
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryFile')}</TooltipContent>
        </Tooltip>
      )}
    />
  );
  return {
  artifactPreview, fileLoadingState, renderFileErrorState,
  };
}
