import React from 'react';
import { isAudioFile, isBinaryFile, isDelimitedTableFile, isDrawioFile, isExcalidrawFile, isFontFile, isImageFile, isMermaidFile, isNotebookFile, isPdfFile, isSvgFile, isVideoFile } from '@/lib/toolHelpers';
import { useGuestFileEditor } from '@/lib/guests/file-editors';
import { useGuestsStore } from '@/lib/guests/store';
import { GUEST_FILE_EDITOR_CONTENT_MAX } from '@openchamber/sdk';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { getDisplayPath } from './fileViewPaths';
import { isMarkdownFile, isJsonFile, isHtmlFile } from './fileViewKinds';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileDraft } from './useFileSaving';
import { type useFileDocument } from './useFileDocument';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { type useFileViewModes } from './useFilePreviewModes';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

export function useFileKinds({ canvasState, draft, fileDocument, scope, tabs, viewModes, files }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'binaryCanvasRef' | 'canvasDirty'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'artifactSize' | 'contentDetectedBinary' | 'fileContent'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFileIsOutsideWorkspace' | 'selectedFilePath'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewMode' | 'drawioViewMode' | 'htmlViewMode' | 'jsonViewMode' | 'mdViewMode' | 'mermaidViewMode' | 'svgViewMode' | 'tableViewMode' | 'textViewMode'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
}) {
  const { binaryCanvasRef, canvasDirty } = canvasState;
  const { draftContent } = draft;
  const { artifactSize, contentDetectedBinary, fileContent } = fileDocument;
  const { root } = scope;
  const { selectedFile, selectedFileIsOutsideWorkspace, selectedFilePath } = tabs;
  const { canvasViewMode, drawioViewMode, htmlViewMode, jsonViewMode, mdViewMode, mermaidViewMode, svgViewMode, tableViewMode, textViewMode } = viewModes;

  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && isSvgFile(selectedFile.path));
  const isSvgSource = isSelectedSvg && svgViewMode === 'edit';
  const isSelectedPdf = Boolean(selectedFile?.path && isPdfFile(selectedFile.path));
  const isSelectedVideo = Boolean(selectedFile?.path && isVideoFile(selectedFile.path));
  const isSelectedMedia = isSelectedVideo || Boolean(selectedFile?.path && isAudioFile(selectedFile.path));
  const isSelectedFont = Boolean(selectedFile?.path && isFontFile(selectedFile.path));
  const isSelectedBinary = Boolean(
    selectedFile?.path
    && (isBinaryFile(selectedFile.path) || contentDetectedBinary)
  );
  const isUnsupportedBinary = isSelectedBinary && !isSelectedImage && !isSelectedPdf && !isSelectedMedia && !isSelectedFont;
  const isSelectedNonText = isSelectedBinary || (isSelectedImage && !isSvgSource);

  const displaySelectedPath = React.useMemo(() => {
    return getDisplayPath(root, selectedFilePath);
  }, [selectedFilePath, root]);

  const canCopy = Boolean(selectedFile && (!isSelectedImage || isSelectedSvg) && !isSelectedPdf && !isUnsupportedBinary && fileContent.length > 0);
  const canCopyPath = Boolean(selectedFile && displaySelectedPath.length > 0);
  const canEdit = Boolean(selectedFile && !selectedFileIsOutsideWorkspace && !isSelectedBinary && (!isSelectedImage || isSelectedSvg) && files.writeFile);
  const isTextFile = Boolean(selectedFile && !isSelectedBinary && (!isSelectedImage || isSelectedSvg));
  const matchedGuestFileEditor = useGuestFileEditor(selectedFile?.path, canvasDirty);
  const guestFileEditor = matchedGuestFileEditor && (isTextFile || matchedGuestFileEditor.editor.content === 'binary')
    ? matchedGuestFileEditor
    : null;
  const claimedByGuest = guestFileEditor !== null;
  const enterpriseMode = useEnterpriseMode();
  const binaryCanvas = guestFileEditor?.editor.content === 'binary';
  binaryCanvasRef.current = binaryCanvas;
  const isMarkdown = !claimedByGuest && Boolean(selectedFile?.path && isMarkdownFile(selectedFile.path));
  const isJson = !claimedByGuest && Boolean(selectedFile?.path && isJsonFile(selectedFile.path));
  const isHtml = !claimedByGuest && Boolean(selectedFile?.path && isHtmlFile(selectedFile.path));
  const isDrawio = !claimedByGuest && !enterpriseMode && Boolean(selectedFile?.path && isDrawioFile(selectedFile.path));
  const isMermaid = !claimedByGuest && Boolean(selectedFile?.path && isMermaidFile(selectedFile.path));
  const isTable = !claimedByGuest && !contentDetectedBinary && Boolean(selectedFile?.path && isDelimitedTableFile(selectedFile.path));
  const isNotebook = !claimedByGuest && Boolean(selectedFile?.path && isNotebookFile(selectedFile.path));
  const isTableView = isTable || isNotebook;
  const hasCanvas = claimedByGuest;
  const canMountCanvas = claimedByGuest && (binaryCanvas
    ? artifactSize === null || artifactSize <= GUEST_FILE_EDITOR_CONTENT_MAX
    : draftContent.length <= GUEST_FILE_EDITOR_CONTENT_MAX);
  const guestCatalogStatus = useGuestsStore((state) => state.status);
  const suggestExcalidrawExtension = !claimedByGuest && isTextFile && guestCatalogStatus !== 'unsupported'
    && Boolean(selectedFile?.path && isExcalidrawFile(selectedFile.path));
  const canUseShikiFileView = isTextFile && !isMarkdown && !isDrawio && !hasCanvas
    && !(isHtml && htmlViewMode === 'preview')
    && !(isSelectedSvg && svgViewMode === 'preview')
    && !(isMermaid && mermaidViewMode === 'preview')
    && !(isTableView && tableViewMode === 'table');
  const isEditingFile = (isMarkdown && mdViewMode === 'edit')
    || (isHtml && htmlViewMode === 'edit')
    || (hasCanvas && (canvasViewMode === 'edit' || !canMountCanvas))
    || (isSelectedSvg && svgViewMode === 'edit')
    || (isMermaid && mermaidViewMode === 'edit')
    || (isTableView && tableViewMode === 'text')
    || (isJson && jsonViewMode === 'text')
    || (!isMarkdown && !isHtml && !isJson && !hasCanvas && !isSelectedSvg && !isMermaid && !isTableView && textViewMode === 'edit');
  const sourceEditorShown = (isDrawio ? drawioViewMode !== 'preview' : isEditingFile)
    && !(canUseShikiFileView && textViewMode === 'view');
  return {
  isUnsupportedBinary, isSelectedNonText, displaySelectedPath, canCopy,
  isSelectedImage, isSelectedSvg, isSvgSource, isSelectedPdf, isSelectedVideo, isSelectedMedia, isSelectedFont,
  canCopyPath, canEdit, isTextFile, guestFileEditor, binaryCanvas, isMarkdown, isJson, isHtml, isDrawio, isMermaid,
  isTable, isNotebook, isTableView, hasCanvas, canMountCanvas, suggestExcalidrawExtension, canUseShikiFileView,
  sourceEditorShown,
  };
}
