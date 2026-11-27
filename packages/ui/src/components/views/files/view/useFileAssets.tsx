import React from 'react';
import { readAssetBlob, runtimeAssetsNeedFetch } from '@/lib/runtime-asset';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getImageMimeType } from '@/lib/toolHelpers';
import { MAX_DATA_PREVIEW_BYTES, MAX_OFFICE_PREVIEW_BYTES } from '@/lib/fileOpenLimits';
import { useHtmlPreviewUrl } from '../useHtmlPreviewUrl';
import { useRawAssetUrl } from '../useRawAssetUrl';
import { useHtmlPreviewAnnotation } from '../useHtmlPreviewAnnotation';
import { Icon } from '@/components/icon/Icon';
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { isPathWithinRoot, getDisplayPath } from './fileViewPaths';
import { type useFileSaving, type useFileDraft } from './useFileSaving';
import { type useFileKinds } from './useFileKinds';
import { type useFileDocument } from './useFileDocument';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { type useFileViewModes } from './useFilePreviewModes';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useTableDelimiter } from './useTableDelimiter';

export function useFileAssets({ draft, fileDocument, fileKinds, fileSaving, scope, tabs, viewModes, files, isMobile, runtime, t }: {
  draft: Pick<ReturnType<typeof useFileDraft>, 'draftContent'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'desktopImageSrc' | 'fileContent' | 'fileContentRevision' | 'lastLoadedFileStatRef' | 'setFileError'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'isHtml' | 'isSelectedFont' | 'isSelectedImage' | 'isSelectedMedia' | 'isSelectedPdf' | 'isSelectedSvg' | 'isTable'>;
  fileSaving: Pick<ReturnType<typeof useFileSaving>, 'readFileStat'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root' | 'runtimeKey'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'resolveFileReadOptions' | 'selectedFile' | 'selectedFilePathRef' | 'selectedFileReadOptions'>;
  viewModes: Pick<ReturnType<typeof useFileViewModes>, 'htmlViewMode'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  isMobile: boolean;
  runtime: ReturnType<typeof useRuntimeAPIs>['runtime'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { draftContent } = draft;
  const { desktopImageSrc, fileContent, fileContentRevision, lastLoadedFileStatRef, setFileError } = fileDocument;
  const { isHtml, isSelectedFont, isSelectedImage, isSelectedMedia, isSelectedPdf, isSelectedSvg, isTable } = fileKinds;
  const { readFileStat } = fileSaving;
  const { root, runtimeKey } = scope;
  const { resolveFileReadOptions, selectedFile, selectedFilePathRef, selectedFileReadOptions } = tabs;
  const { htmlViewMode } = viewModes;
  const tableDelimiter = useTableDelimiter(isTable && selectedFile ? selectedFile.path : null, fileContent, fileContentRevision);

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

  const relayActive = isRelayModeActive();
  const inlineHtmlPreview = runtimeAssetsNeedFetch();
  const htmlPreviewRequest = React.useMemo(
    () => (selectedFile?.path && isHtml && htmlViewMode === 'preview' && !runtime.isVSCode
      ? {
        runtime: runtimeKey,
        relayActive,
        path: selectedFile.path,
        directory: root || '',
        revision: String(fileContentRevision),
        outsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace,
        inlineDocument: inlineHtmlPreview,
      }
      : null),
    [runtimeKey, relayActive, selectedFile?.path, isHtml, htmlViewMode, runtime.isVSCode, inlineHtmlPreview, root, fileContentRevision, selectedFileReadOptions.allowOutsideWorkspace],
  );

  const assetAuthErrorFallback = t('filesView.error.readFileFailed');
  const htmlPreview = useHtmlPreviewUrl(htmlPreviewRequest, assetAuthErrorFallback);
  const htmlPreviewFrameRef = React.useRef<HTMLIFrameElement | null>(null);
  const htmlPreviewAnnotation = useHtmlPreviewAnnotation({
    frameRef: htmlPreviewFrameRef,
    directory: root,
    pageKey: htmlPreview.status === 'ready' ? htmlPreview.pageKey : '',
    filePath: selectedFile?.path ?? '',
  });
  const canAnnotateHtmlPreview = !isMobile && htmlPreview.status === 'ready';
  const annotateWhenLoadedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (htmlViewMode !== 'preview' || annotateWhenLoadedRef.current !== selectedFile?.path) {
      annotateWhenLoadedRef.current = null;
    }
  }, [htmlViewMode, selectedFile?.path]);
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

  const exportDocument = async (format: 'docx' | 'pdf' | 'xlsx') => {
    if (!selectedFile) return;
    const { markdownToDocx, markdownToPrintableHtml, printHtml, rowsToXlsx } = await import('../previews/documentExport');
    if (format === 'pdf') {
      printHtml(markdownToPrintableHtml(draftContent, selectedFile.name));
      return;
    }
    const delimited = isTable ? await import('../previews/delimitedText') : null;
    const table = delimited ? delimited.parseDelimitedText(draftContent, tableDelimiter, Number.MAX_SAFE_INTEGER) : null;
    const bytes = table ? await rowsToXlsx(selectedFile.name, [table.header, ...table.rows]) : await markdownToDocx(draftContent);
    const stem = selectedFile.path.replace(/\.[^./\\]+$/, '');
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
  assetAuthErrorFallback, htmlPreview, htmlPreviewFrameRef, htmlPreviewAnnotation,
  canAnnotateHtmlPreview, annotateWhenLoadedRef, rawAsset, isPdfAssetAuthLoading, imageSrc, pdfSrc, downloadButton,
  loadCanvasBytes, maxDataBytes, loadOfficeBytes, loadDataBytes, exportDocument, saveOfficeBytes, binaryFileActions, tableDelimiter,
  };
}
