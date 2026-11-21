import React from 'react';
import { File as PierreFile, VirtualizerContext, WorkerPoolContext } from '@pierre/diffs/react';
import { DEFAULT_VIRTUAL_FILE_METRICS } from '@pierre/diffs';
import { useWorkerPool } from '@/contexts/DiffWorkerProvider';
import { useFileViewVirtualizer } from '../../useFileViewVirtualizer';
import { useFilePreviewScrollPosition } from '../../useFilePreviewScrollPosition';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { LARGE_FILE_CHAR_THRESHOLD, makeFileContentCacheKey } from '../../fileEditorContent';
import { shouldShowFileCanvas } from '@/components/views/files/fileCanvas';
import { useUIStore } from '@/stores/useUIStore';
import { useMarkdownLocalAssets } from '../previews/useMarkdownLocalAssets';
import { buildCodeMirrorCommentWidgets } from '@/components/comments';
import { DIFFS_HIGHLIGHTER, toDiffsLanguage } from '@/lib/shiki/diffsHighlighter';
import { type FileNode } from './fileViewTypes';
import { type useFileComments } from './useFileComments';
import { type useFileKinds } from './useFileKinds';
import { type useFilePreviewModes, type useFileViewModes } from './useFilePreviewModes';
import { type useFileEditorExtensions, type useFileEditor } from './useFileEditorExtensions';
import { type useFileDraft } from './useFileSaving';
import { type useFileDocument } from './useFileDocument';
import { type useFileMarkdownPreview } from './useFileMarkdownPreview';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { type useFileThemes } from './useFileThemes';

export function useFilePreviewRendering({ draft, editor, fileComments, fileDocument, fileEditorExtensions, fileKinds, filePreviewModes, markdownPreview, scope, tabs, themes, viewModes }: {
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent'>;
  editor: Pick<ReturnType<typeof useFileEditor>, 'wrapLines'>;
  fileComments: Pick<ReturnType<typeof useFileComments>, 'cancel' | 'commentText' | 'deleteDraft' | 'editingDraftId' | 'filesLineDrafts' | 'handleSaveComment' | 'isDragging' | 'lineSelection' | 'markdownPreviewRef' | 'setCommentText' | 'setLineSelection' | 'startEdit'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileError' | 'fileLoading' | 'filePositionKey' | 'loadedFilePath'>;
  fileEditorExtensions: Pick<ReturnType<typeof useFileEditorExtensions>, 'editorCode' | 'pierreTheme'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canMountCanvas' | 'canUseShikiFileView' | 'hasCanvas' | 'isJson' | 'isMarkdown'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'getMdViewMode'>;
  markdownPreview: Pick<ReturnType<typeof useFileMarkdownPreview>, 'mdPreviewContainerRef'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'panelRoot' | 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFilePath'>;
  themes: Pick<ReturnType<typeof useFileThemes>, 'currentTheme'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewMode' | 'jsonViewMode' | 'mdViewMode' | 'textViewMode'>;
}) {
  const { draftContent } = draft;
  const { wrapLines } = editor;
  const { cancel, commentText, deleteDraft, editingDraftId, filesLineDrafts, handleSaveComment, isDragging, lineSelection, markdownPreviewRef, setCommentText, setLineSelection, startEdit } = fileComments;
  const { fileError, fileLoading, filePositionKey, loadedFilePath } = fileDocument;
  const { editorCode, pierreTheme } = fileEditorExtensions;
  const { canMountCanvas, canUseShikiFileView, hasCanvas, isJson, isMarkdown } = fileKinds;
  const { getMdViewMode } = filePreviewModes;
  const { mdPreviewContainerRef } = markdownPreview;
  const { panelRoot, root } = scope;
  const { selectedFile, selectedFilePath } = tabs;
  const { currentTheme } = themes;
  const { canvasViewMode, jsonViewMode, mdViewMode, textViewMode } = viewModes;

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: filesLineDrafts,
      editingDraftId,
      commentText,
      onTextChange: setCommentText,
      selection: lineSelection,
      isDragging,
      fileLabel: selectedFile?.path ?? '',
      newWidgetId: 'files-new-comment-input',
      mapDraftToRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
      onSave: handleSaveComment,
      onCancel: () => {
        setLineSelection(null);
        cancel();
      },
      onEdit: (draft) => {
        startEdit(draft);
        setLineSelection({ start: draft.startLine, end: draft.endLine });
      },
      onDelete: deleteDraft,
    });
  }, [cancel, commentText, deleteDraft, editingDraftId, filesLineDrafts, handleSaveComment, isDragging, lineSelection, selectedFile?.path, setCommentText, startEdit]);

  const mainViewVirtualizer = useFileViewVirtualizer();
  const previewReady = !fileLoading && !fileError && loadedFilePath === selectedFilePath;
  const showCanvas = React.useMemo(
    () => Boolean(selectedFilePath) && shouldShowFileCanvas({ hasCanvas, viewMode: canvasViewMode, previewReady, mountable: canMountCanvas }),
    [canMountCanvas, canvasViewMode, hasCanvas, previewReady, selectedFilePath],
  );
  const codePreviewActive = previewReady && canUseShikiFileView && textViewMode === 'view'
    && !(isJson && jsonViewMode === 'tree');
  const markdownPreviewActive = previewReady && isMarkdown && getMdViewMode() === 'preview';
  const { setScroller: setMainCodeScroller, restore: restoreMainCodeScroll } = useFilePreviewScrollPosition(codePreviewActive ? `${filePositionKey}:code` : null);
  const { setScroller: setMainMarkdownScroll } = useFilePreviewScrollPosition(markdownPreviewActive ? `${filePositionKey}:markdown` : null);
  const { setScroller: connectMainVirtualizer } = mainViewVirtualizer;

  const setMainPreviewScroller = React.useCallback((node: HTMLElement | null) => {
    connectMainVirtualizer(node);
    setMainCodeScroller(node);
  }, [connectMainVirtualizer, setMainCodeScroller]);
  const setMainMarkdownScroller = React.useCallback((node: HTMLDivElement | null) => {
    markdownPreviewRef.current = node;
    mdPreviewContainerRef.current = node;
    setMainMarkdownScroll(node);
  }, [setMainMarkdownScroll]);
  const openLinkedFile = React.useCallback((absolutePath: string) => {
    if (!panelRoot) return;
    useUIStore.getState().openContextFile(panelRoot, absolutePath);
  }, [panelRoot]);
  const markdownLocalAssetsActive = isMarkdown && mdViewMode === 'preview' && !fileLoading;
  const markdownColorScheme = currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
  const markdownDocumentAssets = useMarkdownLocalAssets({
    filePath: selectedFile?.path ?? null,
    workspaceRoot: root || null,
    onOpenFile: openLinkedFile,
    enabled: markdownLocalAssetsActive,
    colorScheme: markdownColorScheme,
  });
  const shikiWorkerPool = useWorkerPool('unified');
  const isLargeFile = draftContent.length > LARGE_FILE_CHAR_THRESHOLD;
  const largeFileCacheKey = React.useMemo(
    () => (isLargeFile && codePreviewActive ? makeFileContentCacheKey(draftContent) : undefined),
    [codePreviewActive, draftContent, isLargeFile],
  );

  const renderShikiFileView = React.useCallback((file: FileNode, content: string) => {
    const fileContents = {
      name: file.name,
      contents: content,
      lang: toDiffsLanguage(getLanguageFromExtension(file.path)),
    };
    const pierreFile = (key: string) => (
      <PierreFile
        key={key}
        file={isLargeFile && largeFileCacheKey ? { ...fileContents, cacheKey: `${file.path}:${largeFileCacheKey}` } : fileContents}
        options={{
          disableFileHeader: true,
          overflow: wrapLines ? 'wrap' : 'scroll',
          theme: pierreTheme,
          themeType: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
          preferredHighlighter: DIFFS_HIGHLIGHTER,
          onPostRender: restoreMainCodeScroll,
        }}
        className={isLargeFile ? 'block w-full' : 'block h-full w-full'}
        style={isLargeFile ? undefined : { height: '100%' }}
        metrics={editorCode ? { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: editorCode.lineHeight } : undefined}
      />
    );

    if (!isLargeFile) {
      return <div className="h-full" style={editorCode?.style}>{pierreFile(file.path)}</div>;
    }

    return (
      <div className="h-full" style={editorCode?.style}>
        <VirtualizerContext.Provider value={mainViewVirtualizer.virtualizer}>
          <WorkerPoolContext.Provider value={shikiWorkerPool}>
            {pierreFile(`${file.path}:${shikiWorkerPool ? 'pool' : 'pending'}:${editorCode?.lineHeight ?? 'default'}`)}
          </WorkerPoolContext.Provider>
        </VirtualizerContext.Provider>
      </div>
    );
  }, [currentTheme.metadata.variant, editorCode, isLargeFile, largeFileCacheKey, mainViewVirtualizer.virtualizer, pierreTheme, restoreMainCodeScroll, shikiWorkerPool, wrapLines]);
  return {
  blockWidgets, showCanvas, setMainPreviewScroller, setMainMarkdownScroller, markdownDocumentAssets, isLargeFile,
  renderShikiFileView,
  };
}
