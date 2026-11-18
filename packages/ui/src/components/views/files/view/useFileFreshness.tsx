import React from 'react';
import { createFileContentPoller } from '../../fileContentPoller';
import { hasFileStatChanged, openFilePollStep } from '../../fileStatChange';
import { isBinaryFile, isDrawioFile, isImageFile, looksLikeBinaryText } from '@/lib/toolHelpers';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { subscribeToFileContentInvalidation } from '@/lib/fileContentInvalidation';
import { isFilePathMoveInFlight } from '@/lib/filePathMoves';
import { isFileMissingError } from '@/lib/api/files-errors';
import { watchFileOnScreen } from '@/lib/watchedFiles';
import { normalizePath } from './fileViewPaths';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileDiagram } from './useFilePreviewModes';
import { type useFileDocument } from './useFileDocument';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { useI18n } from '@/lib/i18n';

const MAX_CONTENT_POLL_BYTES = 200_000;
const WATCHED_FILE_POLL_MS = 30_000;

export function useFileFreshness({ diagram, draft, fileDocument, fileSaving, scope, tabs, t, visible }: {
  diagram: Pick<ReturnType<typeof useFileDiagram>, 'diagramSavedXmlRef' | 'diagramXmlRef'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'setDraftContent'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'activeFileLoadIdRef' | 'contentDetectedBinary' | 'failedFilePath' | 'lastLoadedFileContentRef' | 'lastLoadedFileRevisionRef' | 'lastLoadedFileStatRef' | 'loadedFilePath' | 'loadingFilePathRef' | 'missingSeenPathRef' | 'pendingPathMoveRef' | 'setDesktopImageSrc' | 'setFailedFilePath' | 'setFileContent' | 'setFileContentRevision' | 'setFileError' | 'setLoadedFilePath'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'applyLoadedTextContent' | 'isDirty' | 'readFile' | 'readFileStat'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'fileScopeRef' | 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  t: ReturnType<typeof useI18n>['t'];
  visible: boolean;
}) {
  const { diagramSavedXmlRef, diagramXmlRef } = diagram;
  const { setDraftContent } = draft;
  const { activeFileLoadIdRef, contentDetectedBinary, failedFilePath, lastLoadedFileContentRef, lastLoadedFileRevisionRef, lastLoadedFileStatRef, loadedFilePath, loadingFilePathRef, missingSeenPathRef, pendingPathMoveRef, setDesktopImageSrc, setFailedFilePath, setFileContent, setFileContentRevision, setFileError, setLoadedFilePath } = fileDocument;
  const { applyLoadedTextContent, isDirty, readFile, readFileStat } = fileSaving;
  const { fileScopeRef, root } = scope;
  const { selectedFile } = tabs;

  const isDirtyRef = React.useRef(isDirty);
  isDirtyRef.current = isDirty;

  const reloadSelectedFile = React.useCallback(() => {
    activeFileLoadIdRef.current += 1;
    loadingFilePathRef.current = null;
    lastLoadedFileStatRef.current = null;
    setDesktopImageSrc('');
    setFileError(null);
    setLoadedFilePath(null);
    setFileContentRevision((revision) => revision + 1);
  }, []);

  React.useEffect(() => subscribeToFileContentInvalidation(({ runtimeKey, paths }) => {
    const selectedPath = selectedFile?.path;
    if (
      runtimeKey !== getRuntimeKey()
      || !selectedPath
      || isDirtyRef.current
      || !paths.includes(normalizePath(selectedPath))
    ) {
      return;
    }

    reloadSelectedFile();
  }), [reloadSelectedFile, selectedFile?.path]);

  React.useEffect(() => {
    if (!visible || !selectedFile?.path || (loadedFilePath !== selectedFile.path && failedFilePath !== selectedFile.path)) {
      return;
    }

    const selectedPath = selectedFile.path;
    const showsFailure = failedFilePath === selectedPath;
    const requestRuntime = getRuntimeKey();
    const requestScope = fileScopeRef.current;
    const hasUnsavedChanges = () => isDirtyRef.current || (
      isDrawioFile(selectedPath) && diagramXmlRef.current !== diagramSavedXmlRef.current
    );
    const contentPoller = !isBinaryFile(selectedPath) && !isImageFile(selectedPath) && !contentDetectedBinary
      ? createFileContentPoller({
          readContent: () => readFile(selectedPath, { fresh: true }),
          getLoadedContent: () => lastLoadedFileContentRef.current,
          getLoadedRevision: () => lastLoadedFileRevisionRef.current,
          isDirty: hasUnsavedChanges,
          applyContent: (content) => {
            if (cancelled || getRuntimeKey() !== requestRuntime || fileScopeRef.current !== requestScope) return;
            if (looksLikeBinaryText(content)) {
              setLoadedFilePath(null);
              return;
            }
            applyLoadedTextContent(content);
          },
        })
      : null;

    let cancelled = false;
    let polling = false;
    let pollAgain = false;
    const poll = () => {
      if (document.hidden) {
        return;
      }
      if (polling) {
        pollAgain = true;
        return;
      }

      polling = true;
      void readFileStat(selectedPath)
        .then(async (latestStat) => {
          if (cancelled || getRuntimeKey() !== requestRuntime || fileScopeRef.current !== requestScope || !latestStat) {
            return;
          }

          const sawMissing = missingSeenPathRef.current === selectedPath;
          const step = openFilePollStep({ stat: 'found', showsFailure, sawMissing, hasUnsavedChanges: hasUnsavedChanges(), moving: false });
          if (step === 'reload') {
            lastLoadedFileStatRef.current = null;
            setLoadedFilePath(null);
            setFileContentRevision((revision) => revision + 1);
            return;
          }
          if (step !== 'check-changes') {
            return;
          }

          const previousStat = lastLoadedFileStatRef.current;
          if (!previousStat || previousStat.path !== selectedPath) {
            lastLoadedFileStatRef.current = latestStat;
            return;
          }

          if (!hasFileStatChanged(previousStat, latestStat)) {
            return;
          }

          if (contentPoller && latestStat.size <= MAX_CONTENT_POLL_BYTES) {
            const observed = await contentPoller.poll();
            if (observed && !cancelled) {
              lastLoadedFileStatRef.current = latestStat;
            }
            return;
          }

          if (isDirtyRef.current) {
            return;
          }

          lastLoadedFileStatRef.current = latestStat;
          setLoadedFilePath(null);
          setFileContentRevision((revision) => revision + 1);
        })
        .catch((error) => {
          if (cancelled || getRuntimeKey() !== requestRuntime || fileScopeRef.current !== requestScope) return;
          const stat = isFileMissingError(error) ? 'missing' : 'failed';
          const sawMissing = missingSeenPathRef.current === selectedPath;
          const moving = isFilePathMoveInFlight(selectedPath) || pendingPathMoveRef.current !== null;
          if (openFilePollStep({ stat, showsFailure, sawMissing, hasUnsavedChanges: hasUnsavedChanges(), moving }) !== 'show-missing') {
            return;
          }
          missingSeenPathRef.current = selectedPath;
          lastLoadedFileStatRef.current = null;
          setFileContent('');
          setDraftContent('');
          setFileError(error instanceof Error ? error.message : t('filesView.error.readFileFailed'));
          setFailedFilePath(selectedPath);
        })
        .finally(() => {
          polling = false;
          if (pollAgain && !cancelled) {
            pollAgain = false;
            poll();
          }
        });
    };
    poll();
    let interval = window.setInterval(poll, 2000);
    const watch = root ? watchFileOnScreen(root, selectedPath, poll) : null;
    void watch?.watching.then((watching) => {
      if (!watching || cancelled) return;
      window.clearInterval(interval);
      interval = window.setInterval(poll, WATCHED_FILE_POLL_MS);
    });
    const handleVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      contentPoller?.dispose();
      window.clearInterval(interval);
      watch?.stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [applyLoadedTextContent, contentDetectedBinary, failedFilePath, loadedFilePath, readFile, readFileStat, root, selectedFile?.path, t, visible]);
  return {
  reloadSelectedFile,
  };
}
