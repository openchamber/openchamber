import React from 'react';
import { toast } from '@/components/ui';
import { EMPTY_CANVAS_READ, type FileCanvasHandle } from '@/components/views/files/fileCanvas';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { type FilesViewOptions } from './fileViewTypes';
import { type useFileDraft, type useFileSaving } from './useFileSaving';
import { type useFileTabs } from './useFileTabs';
import { GuestFileEditor } from '@/components/views/files/GuestFileEditor';
import { type useFileKinds } from './useFileKinds';
import { type useFilePreviewModes, type useFileViewModes } from './useFilePreviewModes';
import { type useFileAssets } from './useFileAssets';
import { type useFilePreviewRendering } from './useFilePreviewRendering';
import { type useFileDocument } from './useFileDocument';

export function useFileCanvasState() {
  const [canvasRemountNonce, setCanvasRemountNonce] = React.useState(0);
  const canvasEditorRef = React.useRef<FileCanvasHandle | null>(null);
  const [canvasDirty, setCanvasDirty] = React.useState(false);
  const canvasDirtyRef = React.useRef(false);
  canvasDirtyRef.current = canvasDirty;
  const binaryCanvasRef = React.useRef(false);
  const [canvasSaved, setCanvasSaved] = React.useState(false);
  const canvasWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const canvasLastEditAtRef = React.useRef(0);

  return { canvasRemountNonce, setCanvasRemountNonce, canvasEditorRef, canvasDirty, setCanvasDirty, canvasDirtyRef, binaryCanvasRef, canvasSaved, setCanvasSaved, canvasWrapperRef, canvasLastEditAtRef };
}

export function useFileFullscreen({ canvasState, draft, tabs }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'binaryCanvasRef' | 'canvasDirtyRef' | 'canvasEditorRef' | 'setCanvasDirty'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'saveDraftRef' | 'setDraftContent'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFilePathRef'>;
}) {
  const { binaryCanvasRef, canvasDirtyRef, canvasEditorRef, setCanvasDirty } = canvasState;
  const { saveDraftRef, setDraftContent } = draft;
  const { selectedFilePathRef } = tabs;
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const changeFullscreen = React.useCallback((next: boolean) => {
    if (!canvasDirtyRef.current) {
      setIsFullscreen(next);
      return;
    }
    const pathAtToggle = selectedFilePathRef.current;
    if (binaryCanvasRef.current) {
      void saveDraftRef.current?.().then((saved) => {
        if (saved && selectedFilePathRef.current === pathAtToggle) setIsFullscreen(next);
      });
      return;
    }
    void Promise.resolve(canvasEditorRef.current?.getContent('handoff') ?? EMPTY_CANVAS_READ).then((read) => {
      if (selectedFilePathRef.current !== pathAtToggle) return;
      if (!read.ok) {
        toast.error(read.message);
        return;
      }
      if (read.snapshot && 'content' in read.snapshot) {
        setDraftContent(read.snapshot.content);
        setCanvasDirty(false);
      }
      setIsFullscreen(next);
    });
  }, []);

  return { isFullscreen, changeFullscreen };
}

export function useFileCanvas({ canvasState, draft, fileAssets, fileDocument, fileKinds, filePreviewModes, filePreviewRendering, fileSaving, fullscreen, tabs, viewModes, files, mode, t }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'binaryCanvasRef' | 'canvasEditorRef' | 'canvasLastEditAtRef' | 'canvasRemountNonce' | 'canvasWrapperRef' | 'setCanvasDirty' | 'setCanvasRemountNonce'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent'>;
  fileAssets: Pick<ReturnType<typeof useFileAssets>, 'loadCanvasBytes'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'editorDocumentPath' | 'loadedFilePath'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'binaryCanvas' | 'displaySelectedPath' | 'guestFileEditor'>;
  filePreviewModes: Pick<ReturnType<typeof useFilePreviewModes>, 'handleCanvasUnsupported'>;
  filePreviewRendering: Pick<ReturnType<typeof useFilePreviewRendering>, 'showCanvas'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'saveNow'>;
  fullscreen: Pick<ReturnType<typeof useFileFullscreen>, 'isFullscreen'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFileIsOutsideWorkspace' | 'selectedFilePathRef'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'canvasViewModeByPathRef' | 'setCanvasViewMode'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  mode: FilesViewOptions['mode'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { binaryCanvasRef, canvasEditorRef, canvasLastEditAtRef, canvasRemountNonce, canvasWrapperRef, setCanvasDirty, setCanvasRemountNonce } = canvasState;
  const { draftContent } = draft;
  const { loadCanvasBytes } = fileAssets;
  const { editorDocumentPath, loadedFilePath } = fileDocument;
  const { binaryCanvas, displaySelectedPath, guestFileEditor } = fileKinds;
  const { handleCanvasUnsupported } = filePreviewModes;
  const { showCanvas } = filePreviewRendering;
  const { saveNow } = fileSaving;
  const { isFullscreen } = fullscreen;
  const { selectedFile, selectedFileIsOutsideWorkspace, selectedFilePathRef } = tabs;
  const { canvasViewModeByPathRef, setCanvasViewMode } = viewModes;

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

  return {
  canvasInFullscreen, canvasElement, openExcalidrawExtensionCard,
  };
}
