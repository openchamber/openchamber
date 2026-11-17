import React from 'react';
import { toast } from '@/components/ui';
import { type FileStatSnapshot, fileStatSnapshotForRequestedPath } from '../../fileStatChange';
import { EMPTY_CANVAS_READ } from '@/components/views/files/fileCanvas';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { normalizePath, isPathWithinRoot, getDisplayPath } from './fileViewPaths';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isBinaryFile, isDrawioFile } from '@/lib/toolHelpers';
import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from '@/lib/fileEditorAutosave';
import { prepareFileEditorContent, serializeEditorContent } from '../../fileEditorContent';
import { isFilePathMoveInFlight } from '@/lib/filePathMoves';
import { isFileMissingError } from '@/lib/api/files-errors';
import { sessionEvents } from '@/lib/sessionEvents';
import { syncScheduledTaskLoops } from '@/lib/scheduledTasksApi';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opensInFileCanvas } from './fileViewKinds';
import { type useFileCanvasState } from './useFileCanvas';
import { type useFileDiagram } from './useFilePreviewModes';
import { type useFileDocument } from './useFileDocument';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';

export function useFileDraft() {
  const [draftContent, setDraftContent] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDraftRef = React.useRef<(() => Promise<boolean>) | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saved'>('idle');
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);

  return { draftContent, setDraftContent, isSaving, setIsSaving, autoSaveTimerRef, saveDraftRef, autoSaveStatus, setAutoSaveStatus, autoSaveEnabled, shortcutOverrides, setAutoSaveEnabled };
}

export function useFileSaving({ canvasState, diagram, draft, fileDocument, scope, tabs, files, t }: {
  canvasState: Pick<ReturnType<typeof useFileCanvasState>, 'binaryCanvasRef' | 'canvasDirty' | 'canvasEditorRef' | 'canvasLastEditAtRef' | 'setCanvasDirty' | 'setCanvasRemountNonce'>;
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramSavedXmlRef' | 'diagramXmlRef'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'autoSaveEnabled' | 'autoSaveTimerRef' | 'draftContent' | 'isSaving' | 'saveDraftRef' | 'setAutoSaveStatus' | 'setDraftContent' | 'setIsSaving'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'contentDetectedBinary' | 'fileContent' | 'fileLoading' | 'lastLoadedFileContentRef' | 'lastLoadedFileRevisionRef' | 'lastLoadedFileStatRef' | 'loadedFileLineEnding' | 'loadedFilePath' | 'pendingPathMoveRef' | 'setFileContent' | 'setFileContentRevision' | 'setLoadedFileLineEnding'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'openPaths' | 'removeUnselectedOpenPath' | 'resolveFileReadOptions' | 'selectedFile' | 'selectedFilePathRef'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { binaryCanvasRef, canvasDirty, canvasEditorRef, canvasLastEditAtRef, setCanvasDirty, setCanvasRemountNonce } = canvasState;
  const { diagramSavedXmlRef, diagramXmlRef } = diagram;
  const { autoSaveEnabled, autoSaveTimerRef, draftContent, isSaving, saveDraftRef, setAutoSaveStatus, setDraftContent, setIsSaving } = draft;
  const { contentDetectedBinary, fileContent, fileLoading, lastLoadedFileContentRef, lastLoadedFileRevisionRef, lastLoadedFileStatRef, loadedFileLineEnding, loadedFilePath, pendingPathMoveRef, setFileContent, setFileContentRevision, setLoadedFileLineEnding } = fileDocument;
  const { root } = scope;
  const { openPaths, removeUnselectedOpenPath, resolveFileReadOptions, selectedFile, selectedFilePathRef } = tabs;

  // `fresh` bypasses the content cache and HTTP cache so external-change polling
  // compares against the file on disk rather than a cached copy.
  const readFile = React.useCallback(async (path: string, cacheOptions?: { fresh?: boolean }): Promise<string> => {
    const options = resolveFileReadOptions(path);
    if (files.readFile) {
      const result = await files.readFile(path, {
        ...options,
        directory: root || undefined,
        ...cacheOptions,
      });
      return result.content ?? '';
    }

    const params = new URLSearchParams({ path });
    if (options.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (root) {
      params.set('directory', root);
    }
    const response = await runtimeFetch(
      `/api/fs/read?${params.toString()}`,
      { cache: cacheOptions?.fresh ? 'no-store' : 'default', signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || t('filesView.error.readFileFailed'));
    }
    return response.text();
  }, [files, resolveFileReadOptions, root, t]);

  const readFileStat = React.useCallback(async (path: string): Promise<FileStatSnapshot | null> => {
    if (files.statFile) {
      const options = resolveFileReadOptions(path);
      const result = await files.statFile(path, { ...options, directory: root || undefined });
      return fileStatSnapshotForRequestedPath(normalizePath(path), result);
    }
    return null;
  }, [files, resolveFileReadOptions, root]);

  React.useEffect(() => {
    if (!root || !files.statFile || openPaths.length === 0) {
      return;
    }

    let cancelled = false;
    const paths = [...openPaths];

    void Promise.all(paths.map(async (path) => {
      try {
        const options = resolveFileReadOptions(path);
        const stat = await files.statFile?.(path, { ...options, directory: root || undefined });
        if (!cancelled && stat && !stat.isFile) {
          removeUnselectedOpenPath(root, path);
        }
      } catch (error) {
        if (!cancelled && isFileMissingError(error)) {
          removeUnselectedOpenPath(root, path);
        }
      }
    }));

    return () => {
      cancelled = true;
    };
  }, [files, openPaths, removeUnselectedOpenPath, resolveFileReadOptions, root]);

  const isDirty = draftContent !== fileContent || canvasDirty;

  const applyLoadedTextContent = React.useCallback((content: string, remountCanvas = true) => {
    const { content: editorContent, lineEnding } = prepareFileEditorContent(content);
    if (remountCanvas && opensInFileCanvas(selectedFilePathRef.current)) {
      setCanvasRemountNonce((nonce) => nonce + 1);
    }
    lastLoadedFileContentRef.current = content;
    lastLoadedFileRevisionRef.current += 1;
    setFileContentRevision((revision) => revision + 1);
    setLoadedFileLineEnding(lineEnding);
    setFileContent(editorContent);
    diagramXmlRef.current = editorContent;
    diagramSavedXmlRef.current = editorContent;
    setDraftContent(editorContent);
    return editorContent;
  }, []);

  const saveDraft = React.useCallback(async () => {
    if (!selectedFile || !files.writeFile) {
      toast.error(t('filesView.toast.savingNotSupported'));
      return false;
    }

    // A binary file saves only through the extension editor that owns it.
    const selectedIsBinary = (isBinaryFile(selectedFile.path) || contentDetectedBinary) && !binaryCanvasRef.current;
    if (!shouldAllowFileDraftSave({
      selectedFilePath: selectedFile.path,
      loadedFilePath,
      fileLoading,
      isDirty,
      draftContent,
      fileContent,
      isNonEditableBinary: selectedIsBinary,
    })) {
      if (selectedIsBinary) {
        console.warn(`[saveDraft] refusing to save binary file "${selectedFile.path}".`);
      } else if (draftContent === '' && fileContent !== '' && loadedFilePath !== selectedFile.path) {
        console.warn(
          `[saveDraft] refusing to save empty draft for "${selectedFile.path}" (${fileContent.length} bytes were expected). ` +
          'The file may have been read during a concurrent write (O_TRUNC race). ' +
          'Try again after content finishes loading if the save was intentional.',
        );
      }
      return false;
    }

    // Clean draft: treat as success so discard/save dialogs and Ctrl+S are not stranded.
    if (!isDirty) {
      return true;
    }

    // The file is moving: a write now would recreate it at the old path. Once
    // the editor adopts the new path, autosave runs again and saves there.
    if (pendingPathMoveRef.current || isFilePathMoveInFlight(selectedFile.path)) {
      return false;
    }

    setIsSaving(true);

    try {
      // One snapshot: what is written and what is later marked saved are the
      // same state, so edits made during the write stay unsaved. A canvas that
      // cannot answer fails the save instead of writing the stale draft.
      const canvas = canvasDirty ? canvasEditorRef.current : null;
      // A canvas that went away (its extension was paused or removed) took its
      // edits with it; left set, the flag would keep autosave writing forever.
      if (canvasDirty && !canvas) setCanvasDirty(false);
      const canvasRead = canvas ? await canvas.getContent('save') : EMPTY_CANVAS_READ;
      if (!canvasRead.ok) {
        toast.error(canvasRead.message);
        return false;
      }
      const canvasSnapshot = canvasRead.snapshot;
      if (canvasSnapshot && 'bytes' in canvasSnapshot) {
        // Bytes go through the atomic upload write, replacing the file.
        if (!files.uploadFile) {
          toast.error(t('filesView.toast.savingNotSupported'));
          return false;
        }
        // No baseline while writing: the poll records the new stat instead of
        // reading our own write as an external change and reloading the editor.
        lastLoadedFileStatRef.current = null;
        const written = await files.uploadFile(selectedFile.path, new Blob([canvasSnapshot.bytes]), { overwrite: true });
        if (!written?.success) {
          toast.error(t('filesView.toast.writeFileFailed'));
          return false;
        }
        canvasEditorRef.current?.markSaved(canvasSnapshot.signature);
      } else {
        // The file keeps the line endings it was loaded with, drawn or typed.
        const contentToWrite = serializeEditorContent(canvasSnapshot ? canvasSnapshot.content : draftContent, loadedFileLineEnding);
        const result = await files.writeFile(selectedFile.path, contentToWrite);
        if (!result?.success) {
          toast.error(t('filesView.toast.writeFileFailed'));
          return false;
        }
        if (canvasSnapshot) {
          applyLoadedTextContent(contentToWrite, false);
          canvasEditorRef.current?.markSaved(canvasSnapshot.signature);
        } else {
          setFileContent(draftContent);
          lastLoadedFileContentRef.current = contentToWrite;
          lastLoadedFileRevisionRef.current += 1;
        }
      }
      if (root && isPathWithinRoot(selectedFile.path, root)) {
        const relativePath = getDisplayPath(root, selectedFile.path);
        if (relativePath) {
          sessionEvents.requestGitRefresh({ directory: root, paths: [relativePath] });
        }
      }
      if (root && /(?:^|\/)\.agents\/loops\/[^/]+\.md$/i.test(normalizePath(selectedFile.path))) {
        const project = useProjectsStore.getState().projects.find((entry) => normalizePath(entry.path) === normalizePath(root));
        if (project) {
          try {
            await syncScheduledTaskLoops(project.id);
          } catch {
            toast.error(t('sessions.scheduledTasks.dialog.toast.updateFailed'));
          }
        }
      }
      if (selectedFile?.path && isDrawioFile(selectedFile.path)) {
        diagramXmlRef.current = draftContent;
        diagramSavedXmlRef.current = draftContent;
      }
      // Refresh stat after write so polling doesn't see a stale metadata change.
      void readFileStat(selectedFile.path)
        .then((stat) => {
          if (stat) {
            lastLoadedFileStatRef.current = stat;
          }
        })
        .catch(() => {});
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('filesView.toast.saveFailed'));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [applyLoadedTextContent, contentDetectedBinary, draftContent, canvasDirty, fileContent, fileLoading, files, isDirty, loadedFileLineEnding, loadedFilePath, readFileStat, root, selectedFile, t]);
  saveDraftRef.current = saveDraft;

  React.useEffect(() => {
    if (autoSaveEnabled) {
      return;
    }

    setAutoSaveStatus('idle');
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, [autoSaveEnabled]);

  // Auto-save: debounce 1.5s after user stops typing
  const AUTO_SAVE_DELAY = 1500;

  React.useEffect(() => {
    const canWrite = Boolean(selectedFile && files.writeFile);
    const selectedIsBinary = Boolean(selectedFile?.path && (isBinaryFile(selectedFile.path) || contentDetectedBinary)) && !binaryCanvasRef.current;
    if (!shouldScheduleFileAutosave({
      autoSaveEnabled,
      isDirty,
      canWrite,
      isSaving,
      fileLoading,
      selectedFilePath: selectedFile?.path,
      loadedFilePath,
      isNonEditableBinary: selectedIsBinary,
      wouldEmptyFile: draftContent === '' && fileContent !== '',
    })) {
      return;
    }

    // Drawing changes no dependency here (the draft stays put while the canvas
    // is dirty), so the timer re-arms itself until the canvas has been quiet
    // for the full delay, like typing does.
    const schedule = (delay: number) => {
      autoSaveTimerRef.current = setTimeout(() => {
        const quietFor = Date.now() - canvasLastEditAtRef.current;
        if (quietFor < AUTO_SAVE_DELAY) {
          schedule(AUTO_SAVE_DELAY - quietFor);
          return;
        }
        void saveDraft().then((saved) => {
          if (!saved) return;
          setAutoSaveStatus('saved');
          setTimeout(() => setAutoSaveStatus('idle'), 2000);
        });
      }, delay);
    };
    schedule(AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [autoSaveEnabled, contentDetectedBinary, draftContent, fileContent, fileLoading, isDirty, loadedFilePath, selectedFile, files.writeFile, isSaving, saveDraft]);

  // Reset auto-save status when switching files
  React.useEffect(() => {
    setAutoSaveStatus('idle');
  }, [selectedFile?.path]);

  const saveNow = React.useCallback(() => {
    // Cancel pending auto-save because the explicit save should run immediately.
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (!isSaving) {
      void saveDraft().then((saved) => {
        if (!saved) return;
        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus('idle'), 2000);
      });
    }
  }, [isSaving, saveDraft]);

  return {
  readFile, readFileStat, isDirty, applyLoadedTextContent, saveDraft, AUTO_SAVE_DELAY, saveNow,
  };
}
