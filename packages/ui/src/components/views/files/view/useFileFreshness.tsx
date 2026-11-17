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
/** The open file's check while OpenCode watches it: only for a watch lost on an OpenCode restart. */
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

  // Sync isDirty to a ref so the polling interval can read the latest value
  // without isDirty in its dependency array (avoids interval restart on every edit/save).
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

  // Poll open file for external changes. Metadata is compared first so an
  // unchanged file never reads content, and a changed text file swaps content
  // in place; only other files fall back to a full reload. A file that is
  // missing shows the read error, and loads again once it is back.
  React.useEffect(() => {
    if (!visible || !selectedFile?.path || (loadedFilePath !== selectedFile.path && failedFilePath !== selectedFile.path)) {
      return;
    }

    const selectedPath = selectedFile.path;
    const showsFailure = failedFilePath === selectedPath;
    const requestRuntime = getRuntimeKey();
    const requestScope = fileScopeRef.current;
    // draw.io preview edits live in the XML refs, not the draft buffer, so an
    // in-place content swap has to treat them as unsaved too.
    const hasUnsavedChanges = () => isDirtyRef.current || (
      isDrawioFile(selectedPath) && diagramXmlRef.current !== diagramSavedXmlRef.current
    );
    // Same exclusions as `isTextFile`: `isBinaryFile` covers PDFs, `isImageFile` covers SVG.
    const contentPoller = !isBinaryFile(selectedPath) && !isImageFile(selectedPath) && !contentDetectedBinary
      ? createFileContentPoller({
          readContent: () => readFile(selectedPath, { fresh: true }),
          getLoadedContent: () => lastLoadedFileContentRef.current,
          getLoadedRevision: () => lastLoadedFileRevisionRef.current,
          isDirty: hasUnsavedChanges,
          applyContent: (content) => {
            if (cancelled || getRuntimeKey() !== requestRuntime || fileScopeRef.current !== requestScope) return;
            // An external write can turn a text file binary; reload so the
            // binary guards run instead of pasting binary into the editor.
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
    // A change reported while a check runs gets a check of its own after it.
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
            // Only an observed read retires the change; a dirty buffer or a
            // failed read leaves the baseline so the next tick retries.
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
          // Reset loadedFilePath so the effect above triggers a single reload.
          // A PDF, media or font preview holds its URL per revision, so the
          // revision is what makes it load the new bytes.
          setLoadedFilePath(null);
          setFileContentRevision((revision) => revision + 1);
        })
        .catch((error) => {
          if (cancelled || getRuntimeKey() !== requestRuntime || fileScopeRef.current !== requestScope) return;
          // Unsaved edits stay on screen; saving writes the file back.
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
    // Once OpenCode watches the file, its change event starts the check and
    // the poll only covers a watch OpenCode lost on a restart.
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
