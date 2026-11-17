import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileKinds } from './useFileKinds';

export function useFileImageLoading({
  t, files, root, selectedFile, selectedFileReadOptions, resolveFileReadOptions, setFileLoading, setFileError,
  setDesktopImageSrc, setLoadedFilePath, setFailedFilePath, fileContentRevision, isSelectedImage, isSelectedSvg,
}: Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'root' | 'selectedFile' | 'selectedFileReadOptions' | 'resolveFileReadOptions' |
  'setFileLoading' | 'setFileError' | 'setDesktopImageSrc' | 'setLoadedFilePath' | 'setFailedFilePath' |
  'fileContentRevision'> &
Pick<ReturnType<typeof useFileKinds>,
  'isSelectedImage' | 'isSelectedSvg'>) {
  React.useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    const resolveDesktopImage = async () => {
      if (!selectedFile?.path || !isSelectedImage || isSelectedSvg) {
        setDesktopImageSrc('');
        return;
      }

      setFileError(null);

      const readOptions = resolveFileReadOptions(selectedFile.path);
      if (cancelled) {
        return;
      }

      const srcPromise = files.readFileBinary
        ? files.readFileBinary(selectedFile.path, readOptions).then((result) => result.dataUrl)
        : (async () => {
          const response = await runtimeFetch('/api/fs/raw', {
            signal: AbortSignal.timeout(30_000),
            query: {
              path: selectedFile.path,
              allowOutsideWorkspace: readOptions.allowOutsideWorkspace ? 'true' : undefined,
              directory: root || undefined,
            },
          });
          if (!response.ok) {
            throw new Error(t('filesView.error.readFileFailed'));
          }
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = '';
            return '';
          }
          return objectUrl;
        })();

      await srcPromise
        .then((src) => {
          if (!cancelled) {
            setDesktopImageSrc(src);
            setLoadedFilePath(selectedFile.path);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDesktopImageSrc('');
            setFileError(error instanceof Error ? error.message : t('filesView.error.readFileFailed'));
            // Marked failed like a text read. Clearing the loaded path would make
            // the selection effect load the file again, which wipes this error
            // without fetching the image and leaves the viewer empty.
            setFailedFilePath(selectedFile.path);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setFileLoading(false);
          }
        });
    };

    void resolveDesktopImage();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [fileContentRevision, files, isSelectedImage, isSelectedSvg, resolveFileReadOptions, root, selectedFile?.path, selectedFileReadOptions, t]);
}
