import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { type useFileKinds } from './useFileKinds';
import { type useFileDocument } from './useFileDocument';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

export function useFileImageLoading({ fileDocument, fileKinds, scope, tabs, files, t }: {
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'fileContentRevision' | 'setDesktopImageSrc' | 'setFailedFilePath' | 'setFileError' | 'setFileLoading' | 'setLoadedFilePath'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isSelectedImage' | 'isSelectedSvg'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'resolveFileReadOptions' | 'selectedFile' | 'selectedFileReadOptions'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { fileContentRevision, setDesktopImageSrc, setFailedFilePath, setFileError, setFileLoading, setLoadedFilePath } = fileDocument;
  const { isSelectedImage, isSelectedSvg } = fileKinds;
  const { root } = scope;
  const { resolveFileReadOptions, selectedFile, selectedFileReadOptions } = tabs;

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
