import React from 'react';
import { toast } from '@/components/ui';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { GuestFileEditor } from '@/components/views/files/GuestFileEditor';
import { useUIStore } from '@/stores/useUIStore';
import type { FilesViewOptions } from './fileViewTypes';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileComments } from './useFileComments';
import type { useFileSaving } from './useFileSaving';
import type { useFileKinds } from './useFileKinds';
import type { useFilePreviewModes } from './useFilePreviewModes';
import type { useFileAssets } from './useFileAssets';
import type { useFilePreviewRendering } from './useFilePreviewRendering';

export function useFileCanvas({
  mode, t, files, isFullscreen, setCanvasViewMode, canvasRemountNonce, setCanvasRemountNonce,
  canvasViewModeByPathRef, selectedFile, selectedFilePathRef, selectedFileIsOutsideWorkspace, loadedFilePath,
  editorDocumentPath, draftContent, canvasEditorRef, setCanvasDirty, binaryCanvasRef, canvasWrapperRef,
  canvasLastEditAtRef, wholeFileComment, saveNow, displaySelectedPath, guestFileEditor, binaryCanvas,
  handleCanvasUnsupported, loadCanvasBytes, showCanvas,
}: Pick<FilesViewOptions, 'mode'> &
Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'isFullscreen' | 'setCanvasViewMode' | 'canvasRemountNonce' | 'setCanvasRemountNonce' |
  'canvasViewModeByPathRef' | 'selectedFile' | 'selectedFilePathRef' | 'selectedFileIsOutsideWorkspace' |
  'loadedFilePath' | 'editorDocumentPath' | 'draftContent' | 'canvasEditorRef' | 'setCanvasDirty' |
  'binaryCanvasRef' | 'canvasWrapperRef' | 'canvasLastEditAtRef'> &
Pick<ReturnType<typeof useFileComments>,
  'wholeFileComment'> &
Pick<ReturnType<typeof useFileSaving>,
  'saveNow'> &
Pick<ReturnType<typeof useFileKinds>,
  'displaySelectedPath' | 'guestFileEditor' | 'binaryCanvas'> &
Pick<ReturnType<typeof useFilePreviewModes>,
  'handleCanvasUnsupported'> &
Pick<ReturnType<typeof useFileAssets>,
  'loadCanvasBytes'> &
Pick<ReturnType<typeof useFilePreviewRendering>,
  'showCanvas'>) {
  // A binary editor reads the file itself at mount, so a reload of the file
  // (the poll found an external change and nothing was unsaved) remounts it.
  // The first load of a path mounts the editor anyway; only a repeat reloads.
  const lastLoadedPathRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!loadedFilePath) return;
    if (binaryCanvasRef.current && lastLoadedPathRef.current === loadedFilePath) setCanvasRemountNonce((nonce) => nonce + 1);
    lastLoadedPathRef.current = loadedFilePath;
  }, [loadedFilePath]);

  const handleCanvasLoadProblem = React.useCallback((message: string) => {
    const path = selectedFilePathRef.current;
    if (path) canvasViewModeByPathRef.current[path] = 'edit';
    setCanvasDirty(false);
    setCanvasViewMode('edit');
    toast.error(message);
  }, []);

  const canvasInFullscreen = mode === 'full' && isFullscreen;
  const canvasKey = selectedFile
    ? `${editorDocumentPath ?? selectedFile.path}:${canvasRemountNonce}:${canvasInFullscreen ? 'fullscreen' : 'docked'}`
    : '';
  const canvasElement = showCanvas && selectedFile && guestFileEditor ? (
    <div ref={canvasWrapperRef} className="h-full overflow-hidden" style={{ minHeight: '400px' }}>
      <GuestFileEditor
        key={`${canvasKey}:${guestFileEditor.guestId}:${guestFileEditor.editor.id}`}
        ref={canvasEditorRef}
        guestId={guestFileEditor.guestId}
        editorId={guestFileEditor.editor.id}
        title={guestFileEditor.editor.title}
        contentKind={binaryCanvas ? 'binary' : 'text'}
        path={displaySelectedPath || selectedFile.path}
        content={draftContent}
        loadBytes={loadCanvasBytes}
        readOnly={!selectedFile || selectedFileIsOutsideWorkspace || !files.writeFile || (binaryCanvas && !files.uploadFile)}
        onDirtyChange={setCanvasDirty}
        onEdit={() => { canvasLastEditAtRef.current = Date.now(); }}
        onSaveRequest={saveNow}
        onUnsupported={handleCanvasUnsupported}
        onTooLarge={() => handleCanvasLoadProblem(t('filesView.fileEditor.tooLarge', { editor: guestFileEditor.editor.title }))}
        onLoadFailed={() => handleCanvasLoadProblem(t('filesView.error.readFileFailed'))}
      />
    </div>
  ) : null;

  const openExcalidrawExtensionCard = React.useCallback(() => {
    useUIStore.getState().openSettingsAt('integrations', 'integrations.extensions.excalidraw');
  }, []);

  // Above the scroller, so an editor opened far down the file is on screen.
  // The fullscreen overlay shows it instead while it is open: one editor at a time.
  const wholeFileCommentPanel = wholeFileComment.editor || wholeFileComment.cards ? (
    <ScrollableOverlay outerClassName="max-h-[50%] shrink-0 border-b border-edge-muted" disableHorizontal>
      {wholeFileComment.editor}
      {wholeFileComment.cards}
    </ScrollableOverlay>
  ) : null;
  return {
  canvasInFullscreen, canvasElement, openExcalidrawExtensionCard, wholeFileCommentPanel,
  };
}
