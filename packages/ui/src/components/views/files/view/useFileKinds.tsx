import React from 'react';
import { isAudioFile, isBinaryFile, isDelimitedTableFile, isDrawioFile, isExcalidrawFile, isFontFile, isImageFile, isMermaidFile, isNotebookFile, isPdfFile, isSvgFile, isVideoFile } from '@/lib/toolHelpers';
import { useGuestFileEditor } from '@/lib/guests/file-editors';
import { useGuestsStore } from '@/lib/guests/store';
import { GUEST_FILE_EDITOR_CONTENT_MAX } from '@openchamber/sdk';
import { getSearchQuery, SearchQuery, setSearchQuery as setEditorSearchQuery } from '@codemirror/search';
import { useUIStore } from '@/stores/useUIStore';
import { type ImageNeighbor } from '../previews/ImageArtifact';
import { imageNeighborsOf } from '../imageNeighbors';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { opencodeClient } from '@/lib/opencode/client';
import type { FileNode } from './fileViewTypes';
import { getParentDirectoryPath, normalizePath, getDisplayPath } from './fileViewPaths';
import { isMarkdownFile, isJsonFile, isHtmlFile } from './fileViewKinds';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileDirectory } from './useFileDirectory';

export function useFileKinds({
  visible, files, isMobile, showGitignored, root, panelRoot, treeScope, treeScopeRef, isSearchOpen, textViewMode,
  mdViewMode, jsonViewMode, htmlViewMode, drawioViewMode, canvasViewMode, svgViewMode, mermaidViewMode,
  tableViewMode, artifactSize, selectedFile, selectedFilePath, selectedFileIsOutsideWorkspace, fileContent,
  fileLoading, fileError, draftContent, binaryCanvasRef, contentDetectedBinary, editorViewRef, setIsGoToLineOpen,
  setIsSymbolsOpen, setMdPreviewOutlineOpen, pendingFileNavigation, mapDirectoryEntries,
}: Pick<FilesViewOptions, 'visible'> &
Pick<ReturnType<typeof useFilesViewState>,
  'files' | 'isMobile' | 'showGitignored' | 'root' | 'panelRoot' | 'treeScope' | 'treeScopeRef' | 'isSearchOpen' |
  'textViewMode' | 'mdViewMode' | 'jsonViewMode' | 'htmlViewMode' | 'drawioViewMode' | 'canvasViewMode' |
  'svgViewMode' | 'mermaidViewMode' | 'tableViewMode' | 'artifactSize' | 'selectedFile' | 'selectedFilePath' |
  'selectedFileIsOutsideWorkspace' | 'fileContent' | 'fileLoading' | 'fileError' | 'draftContent' |
  'binaryCanvasRef' | 'contentDetectedBinary' | 'editorViewRef' | 'setIsGoToLineOpen' | 'setIsSymbolsOpen' |
  'setMdPreviewOutlineOpen' | 'pendingFileNavigation'> &
Pick<ReturnType<typeof useFileDirectory>,
  'mapDirectoryEntries'>) {
  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && isSvgFile(selectedFile.path));
  // SVG is text with a picture in it: the toggle decides which one is shown.
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
  // Everything the viewer shows as an artifact rather than as text.
  const isSelectedNonText = isSelectedBinary || (isSelectedImage && !isSvgSource);

  // The image viewer steps through the images of the shown image's folder, in
  // the tree's order and with its hidden and gitignored settings. The folder is
  // read again for every image shown, so files added or removed meanwhile
  // count; the last listing keeps the arrows on screen while it is read. An
  // image the listing leaves out (a gitignored one with those hidden) gets no
  // arrows.
  const imageFolder = visible && selectedFile && isSelectedImage && !isSvgSource ? getParentDirectoryPath(selectedFile.path) : '';
  const [imageFolderListing, setImageFolderListing] = React.useState<{ scope: string; folder: string; readFor: string; entries: FileNode[] } | null>(null);
  const imageFolderListingCurrent = Boolean(imageFolder && imageFolderListing?.scope === treeScope && imageFolderListing.folder === imageFolder);
  const imageFolderHasSelected = Boolean(imageFolderListingCurrent && imageFolderListing?.entries.some((entry) => entry.path === selectedFilePath));
  const imageFolderNeedsRead = Boolean(imageFolder) && !(imageFolderListingCurrent && imageFolderListing?.readFor === selectedFilePath);
  React.useEffect(() => {
    if (!imageFolderNeedsRead) return;
    let cancelled = false;
    const scope = treeScope;
    const folder = imageFolder;
    const readFor = selectedFilePath;
    const respectGitignore = !showGitignored;
    const read = files.listDirectory
      ? files.listDirectory(folder, { respectGitignore }).then((result) => result.entries)
      : opencodeClient.listLocalDirectory(folder, { respectGitignore });
    read.then((entries) => {
      if (cancelled || treeScopeRef.current !== scope) return;
      setImageFolderListing({ scope, folder, readFor, entries: mapDirectoryEntries(folder, entries) });
    }).catch((error) => {
      // Without the listing the viewer simply shows no arrows.
      if (!cancelled) console.warn('Failed to list the image folder:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [files, imageFolder, imageFolderNeedsRead, mapDirectoryEntries, selectedFilePath, showGitignored, treeScope]);
  const imageNeighbors = React.useMemo(() => {
    if (!imageFolderHasSelected || !imageFolderListing || !panelRoot) return null;
    const neighbors = imageNeighborsOf(imageFolderListing.entries, selectedFilePath);
    if (!neighbors) return null;
    // Opened like a single click in the tree: one preview tab follows the steps.
    const toNeighbor = (node: FileNode): ImageNeighbor => ({
      name: node.name,
      open: () => useUIStore.getState().openContextFile(panelRoot, node.path, { preview: true }),
    });
    return { previous: toNeighbor(neighbors.previous), next: toNeighbor(neighbors.next) };
  }, [imageFolderHasSelected, imageFolderListing, panelRoot, selectedFilePath]);
  const pendingNavigationTargetPath = React.useMemo(
    () => normalizePath(pendingFileNavigation?.path ?? ''),
    [pendingFileNavigation?.path],
  );
  const shouldMaskEditorForPendingNavigation = Boolean(
    pendingFileNavigation
      && pendingNavigationTargetPath
      && selectedFilePath
      && selectedFilePath === pendingNavigationTargetPath
      && !fileLoading
      && !fileError
      && !isSelectedNonText,
  );

  const displaySelectedPath = React.useMemo(() => {
    return getDisplayPath(root, selectedFilePath);
  }, [selectedFilePath, root]);

  const canCopy = Boolean(selectedFile && (!isSelectedImage || isSelectedSvg) && !isSelectedPdf && !isUnsupportedBinary && fileContent.length > 0);
  const canCopyPath = Boolean(selectedFile && displaySelectedPath.length > 0);
  // Keep image/SVG on the preview path: `isBinaryFile` excludes `.svg`, so binary
  // alone would flip canEdit/isTextFile true and show a dead edit toggle + no-op Save.
  const canEdit = Boolean(selectedFile && !selectedFileIsOutsideWorkspace && !isSelectedBinary && (!isSelectedImage || isSelectedSvg) && files.writeFile);
  const isTextFile = Boolean(selectedFile && !isSelectedBinary && (!isSelectedImage || isSelectedSvg));
  // An active extension's editor claims a text file ahead of the host's own
  // previews.
  const matchedGuestFileEditor = useGuestFileEditor(selectedFile?.path);
  // Text editors take text files; binary editors take any matching file.
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
  // The draw.io editor is diagrams.net's own page in a frame, and the diagram
  // is handed to it. Enterprise mode keeps file contents away from third
  // parties, so there a .drawio file opens as its XML like any text file.
  const isDrawio = !claimedByGuest && !enterpriseMode && Boolean(selectedFile?.path && isDrawioFile(selectedFile.path));
  const isMermaid = !claimedByGuest && Boolean(selectedFile?.path && isMermaidFile(selectedFile.path));
  // One too large for the editor has no text here, only its table view.
  const isTable = !claimedByGuest && !contentDetectedBinary && Boolean(selectedFile?.path && isDelimitedTableFile(selectedFile.path));
  const isNotebook = !claimedByGuest && Boolean(selectedFile?.path && isNotebookFile(selectedFile.path));
  // Both are text with a richer view that the same toggle switches.
  const isTableView = isTable || isNotebook;
  const hasCanvas = claimedByGuest;
  // A binary editor checks the bytes it reads too; the stat size spares a read.
  const canMountCanvas = claimedByGuest && (binaryCanvas
    ? artifactSize === null || artifactSize <= GUEST_FILE_EDITOR_CONTENT_MAX
    : draftContent.length <= GUEST_FILE_EDITOR_CONTENT_MAX);
  // Excalidraw drawings open in the Excalidraw extension. Without it they show
  // their text and a pointer to the Integrations card, where the runtime can
  // install extensions at all.
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
  // The CodeMirror source is on screen. A draw.io file shows it whenever its diagram is not;
  // a read-only file in its source mode shows the code preview instead.
  // The phone's find bar has no match options: one set on a wider layout must
  // not keep narrowing the search with no way to clear it.
  React.useEffect(() => {
    const view = editorViewRef.current;
    if (!isMobile || !isSearchOpen || !view) return;
    const query = getSearchQuery(view.state);
    if (!query.caseSensitive && !query.regexp && !query.wholeWord) return;
    view.dispatch({ effects: setEditorSearchQuery.of(new SearchQuery({ search: query.search, replace: query.replace })) });
  }, [isMobile, isSearchOpen]);

  const sourceEditorShown = (isDrawio ? drawioViewMode !== 'preview' : isEditingFile)
    && !(canUseShikiFileView && textViewMode === 'view');
  // Go to line and symbols drive that editor: they close when a preview replaces it.
  React.useEffect(() => {
    if (sourceEditorShown) return;
    setIsGoToLineOpen(false);
    setIsSymbolsOpen(false);
  }, [sourceEditorShown]);
  // The outline lists the rendered preview's headings: it closes when the
  // preview goes away and when another file opens.
  const mdPreviewShown = isMarkdown && mdViewMode === 'preview';
  React.useEffect(() => {
    if (!mdPreviewShown) setMdPreviewOutlineOpen(false);
  }, [mdPreviewShown]);
  const outlineFilePath = selectedFile?.path;
  React.useEffect(() => {
    setMdPreviewOutlineOpen(false);
  }, [outlineFilePath]);
  return {
  isSelectedImage, isSelectedSvg, isSvgSource, isSelectedPdf, isSelectedVideo, isSelectedMedia, isSelectedFont,
  isUnsupportedBinary, imageNeighbors, shouldMaskEditorForPendingNavigation, displaySelectedPath, canCopy,
  canCopyPath, canEdit, isTextFile, guestFileEditor, binaryCanvas, isMarkdown, isJson, isHtml, isDrawio, isMermaid,
  isTable, isNotebook, isTableView, hasCanvas, canMountCanvas, suggestExcalidrawExtension, canUseShikiFileView,
  sourceEditorShown,
  };
}
