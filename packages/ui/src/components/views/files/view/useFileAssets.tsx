import React from 'react';
import { readAssetBlob } from '@/lib/runtime-asset';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getImageMimeType } from '@/lib/toolHelpers';
import { MAX_DATA_PREVIEW_BYTES, MAX_OFFICE_PREVIEW_BYTES } from '@/lib/fileOpenLimits';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { useHtmlPreviewUrl } from '../useHtmlPreviewUrl';
import { useRawAssetUrl } from '../useRawAssetUrl';
import { useHtmlPreviewAnnotation } from '../useHtmlPreviewAnnotation';
import { Icon } from '@/components/icon/Icon';
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { isPathWithinRoot, getDisplayPath } from './fileViewPaths';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileSaving } from './useFileSaving';
import type { useFileKinds } from './useFileKinds';

export function useFileAssets({
  t, files, runtime, isMobile, root, runtimeKey, htmlViewMode, selectedFile, selectedFilePathRef,
  selectedFileReadOptions, resolveFileReadOptions, fileContent, setFileError, desktopImageSrc, draftContent,
  lastLoadedFileStatRef, fileContentRevision, readFileStat, isSelectedImage, isSelectedSvg, isSelectedPdf,
  isSelectedMedia, isSelectedFont, isHtml, isTable,
}: Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'runtime' | 'isMobile' | 'root' | 'runtimeKey' | 'htmlViewMode' | 'selectedFile' |
  'selectedFilePathRef' | 'selectedFileReadOptions' | 'resolveFileReadOptions' | 'fileContent' | 'setFileError' |
  'desktopImageSrc' | 'draftContent' | 'lastLoadedFileStatRef' | 'fileContentRevision'> &
Pick<ReturnType<typeof useFileSaving>,
  'readFileStat'> &
Pick<ReturnType<typeof useFileKinds>,
  'isSelectedImage' | 'isSelectedSvg' | 'isSelectedPdf' | 'isSelectedMedia' | 'isSelectedFont' | 'isHtml' |
  'isTable'>) {
  // PDFs, audio, video and fonts are handed to the browser as a URL it owns
  // (iframe, media element, FontFace), so they need the scoped URL token.
  const usesRawAssetUrl = isSelectedPdf || isSelectedMedia || isSelectedFont;
  const rawAssetRequest = React.useMemo(
    () => (selectedFile?.path && usesRawAssetUrl
      ? {
        runtime: runtimeKey,
        path: selectedFile.path,
        directory: root || '',
        revision: String(fileContentRevision),
        outsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace,
      }
      : null),
    [runtimeKey, selectedFile?.path, usesRawAssetUrl, root, fileContentRevision, selectedFileReadOptions.allowOutsideWorkspace],
  );

  // The browser loads an HTML preview and its neighbouring files itself, and a
  // URL it loads never enters the relay tunnel.
  const htmlPreviewUnreachable = isRelayModeActive();
  const htmlPreviewRequest = React.useMemo(
    () => (selectedFile?.path && isHtml && htmlViewMode === 'preview' && !runtime.isVSCode && !htmlPreviewUnreachable
      ? {
        path: selectedFile.path,
        directory: root || '',
        revision: String(fileContentRevision),
        outsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace,
      }
      : null),
    [selectedFile?.path, isHtml, htmlViewMode, runtime.isVSCode, htmlPreviewUnreachable, root, fileContentRevision, selectedFileReadOptions.allowOutsideWorkspace],
  );

  const assetAuthErrorFallback = t('filesView.error.readFileFailed');
  const htmlPreview = useHtmlPreviewUrl(htmlPreviewRequest, assetAuthErrorFallback);
  const htmlPreviewFrameRef = React.useRef<HTMLIFrameElement | null>(null);
  const htmlPreviewAnnotation = useHtmlPreviewAnnotation({
    frameRef: htmlPreviewFrameRef,
    directory: root,
    pageKey: htmlPreview.status === 'ready' ? htmlPreview.url : '',
  });
  // Like the browser panel, annotation is a pointer tool: phones do not get it.
  const canAnnotateHtmlPreview = !isMobile && htmlPreview.status === 'ready';
  // Annotate pressed in the source: the preview of that file starts it once its
  // page loaded. Another file or leaving the preview drops the request.
  const annotateWhenLoadedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (htmlViewMode !== 'preview' || annotateWhenLoadedRef.current !== selectedFile?.path) {
      annotateWhenLoadedRef.current = null;
    }
  }, [htmlViewMode, selectedFile?.path]);
  React.useEffect(() => {
    if (htmlPreview.status === 'error') setFileError(htmlPreview.message);
    else if (htmlPreview.status === 'ready') setFileError(null);
  }, [htmlPreview, setFileError]);
  const rawAsset = useRawAssetUrl(rawAssetRequest, setFileError, assetAuthErrorFallback);
  const isPdfAssetAuthLoading = rawAsset.loading;

  const imageSrc = selectedFile?.path && isSelectedImage
    ? (isSelectedSvg
      ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
      : desktopImageSrc)
    : '';

  const pdfSrc = rawAsset.src;

  const downloadButton = selectedFile && files.downloadFile ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const fn = files.downloadFile;
            if (!fn || !selectedFile) return;
            void fn(selectedFile.path, selectedFileReadOptions).catch((error) => {
              console.error('Download failed:', error);
              toast.error(t('sidebarFilesTree.toast.operationFailed'));
            });
          }}
        >
          <Icon name="download" className="me-2 size-4" />
          {t('filesView.editor.saveFile')}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{t('contextTooltips.files.downloadCopy')}</TooltipContent>
    </Tooltip>
  ) : null;

  const fetchRawFile = React.useCallback(async (path: string, signal: AbortSignal): Promise<Response> => {
    const readOptions = resolveFileReadOptions(path);
    const response = await runtimeFetch('/api/fs/raw', {
      signal,
      cache: 'no-store',
      query: {
        path,
        allowOutsideWorkspace: readOptions.allowOutsideWorkspace ? 'true' : undefined,
        directory: root || undefined,
      },
    });
    if (!response.ok) throw new Error(t('filesView.error.readFileFailed'));
    return response;
  }, [resolveFileReadOptions, root, t]);

  const loadCanvasBytes = React.useCallback(async (): Promise<Uint8Array<ArrayBuffer>> => {
    const path = selectedFilePathRef.current;
    if (!path) throw new Error('No file is open.');
    const response = await fetchRawFile(path, AbortSignal.timeout(60_000));
    return new Uint8Array(await response.arrayBuffer());
  }, [fetchRawFile]);

  // The stat that names the size can arrive after this read starts, so the
  // read is bounded itself and stops when the preview goes away.
  const maxDataBytes = isMobile ? MAX_OFFICE_PREVIEW_BYTES : MAX_DATA_PREVIEW_BYTES;
  const loadOfficeBytes = React.useCallback(async (path: string, cancel: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
    const response = await fetchRawFile(path, signal);
    const blob = await readAssetBlob(response, MAX_OFFICE_PREVIEW_BYTES, signal);
    return new Uint8Array(await blob.arrayBuffer());
  }, [fetchRawFile]);

  const loadDataBytes = React.useCallback(async (path: string, cancel: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(300_000)]);
    const response = await fetchRawFile(path, signal);
    const blob = await readAssetBlob(response, maxDataBytes, signal);
    return new Uint8Array(await blob.arrayBuffer());
  }, [fetchRawFile, maxDataBytes]);

  // Named by path: an edit can still be saving after the viewer moved on.
  // An export lands next to its file, where the agent sees it too.
  const exportDocument = async (format: 'docx' | 'pdf' | 'xlsx') => {
    if (!selectedFile) return;
    const { markdownToDocx, markdownToPrintableHtml, printHtml, rowsToXlsx } = await import('../previews/documentExport');
    if (format === 'pdf') {
      printHtml(markdownToPrintableHtml(draftContent, selectedFile.name));
      return;
    }
    const delimited = isTable ? await import('../previews/delimitedText') : null;
    const table = delimited ? delimited.parseDelimitedText(draftContent, delimited.delimiterForPath(selectedFile.path), Number.MAX_SAFE_INTEGER) : null;
    const bytes = table ? await rowsToXlsx(selectedFile.name, [table.header, ...table.rows]) : await markdownToDocx(draftContent);
    const stem = selectedFile.path.replace(/\.[^./\\]+$/, '');
    // A file already there is the user's: the export takes the next free name.
    let target = `${stem}.${format}`;
    for (let suffix = 2; suffix < 1000 && await readFileStat(target).catch(() => null); suffix += 1) {
      target = `${stem} ${suffix}.${format}`;
    }
    const name = target.split(/[/\\]/).pop() ?? target;
    if (!files.uploadFile) {
      const url = URL.createObjectURL(new Blob([bytes]));
      const link = Object.assign(document.createElement('a'), { href: url, download: name });
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const written = await files.uploadFile(target, new Blob([bytes]), { overwrite: false });
      if (!written?.success) throw new Error('write failed');
      toast.success(t('filesView.export.saved', { name }));
    } catch {
      toast.error(t('filesView.toast.writeFileFailed'));
    }
  };

  const saveOfficeBytes = React.useCallback(async (path: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> => {
    if (!files.uploadFile) return false;
    // No baseline while writing: the poll records the new stat instead of
    // reading our own write as an external change and reloading the preview.
    if (selectedFilePathRef.current === path) lastLoadedFileStatRef.current = null;
    const written = await files.uploadFile(path, new Blob([bytes]), { overwrite: true });
    if (!written?.success) return false;
    if (root && isPathWithinRoot(path, root)) {
      const relativePath = getDisplayPath(root, path);
      if (relativePath) sessionEvents.requestGitRefresh({ directory: root, paths: [relativePath] });
    }
    return true;
  }, [files, root]);

  const openInDefaultAppButton = selectedFile && isDesktopLocalOriginActive() ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void openDesktopPath(selectedFile.path).then((opened) => {
              if (!opened) toast.error(t('sidebarFilesTree.toast.operationFailed'));
            });
          }}
        >
          <Icon name="external-link" className="me-2 size-4" />
          {t('sidebarFilesTree.menu.openInDefaultApp')}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{t('contextTooltips.files.openOutside')}</TooltipContent>
    </Tooltip>
  ) : null;
  const binaryFileActions = <>{downloadButton}{openInDefaultAppButton}</>;
  return {
  htmlPreviewUnreachable, assetAuthErrorFallback, htmlPreview, htmlPreviewFrameRef, htmlPreviewAnnotation,
  canAnnotateHtmlPreview, annotateWhenLoadedRef, rawAsset, isPdfAssetAuthLoading, imageSrc, pdfSrc, downloadButton,
  loadCanvasBytes, maxDataBytes, loadOfficeBytes, loadDataBytes, exportDocument, saveOfficeBytes, binaryFileActions,
  };
}
