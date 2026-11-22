import React, { memo } from 'react';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/lib/fileSize';
import { isDrawioFile, isExcalidrawFile } from '@/lib/toolHelpers';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { getIssueLinkKind, getRepositoryIssueLinkProvider, getTrackerItemLinkProvider, resolveAttachmentOpenTarget, type IssueLinkKind } from '@/lib/messages/attachmentPreview';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useOpenAttachment } from './message/useOpenAttachment';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { StatusImage } from '@/components/ui/status-image';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

import type { ToolPopupContent } from './message/types';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';


export const ActiveEditorFileSuggestion = memo(() => {
  const { t } = useI18n();
  const activeEditorFile = useInputStore((s) => s.activeEditorFile);
  const attachedFiles = useInputStore((s) => s.attachedFiles)
  const addVSCodeFileAttachment = useInputStore((s) => s.addVSCodeFileAttachment)
  const addVSCodeSelectionAttachment = useInputStore((s) => s.addVSCodeSelectionAttachment)
  const isVSCodeRuntime = useRuntimeAPIs().runtime.isVSCode;

  if (!isVSCodeRuntime || !activeEditorFile) return null;

  const { filePath, fileName, relativePath, selection, fileSize } = activeEditorFile;

  const isFileAttached = attachedFiles.some(
    (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === filePath
  )

  let selectionRange = ''
  if (selection) {
    selectionRange = selection.startLine === selection.endLine
      ? `${selection.startLine}`
      : `${selection.startLine}-${selection.endLine}`
  }
  const selectionLabel = selection ? `${relativePath}:${selectionRange}` : ''
  const isSelectionAttached = !!selectionLabel && attachedFiles.some(
    (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === selectionLabel && f.vscodePath === filePath
  )

  if (isFileAttached && (!selection || isSelectionAttached)) return null;

  const ext = fileName.split('.').pop() || '';
  const displayName = fileName;

  const handleAddFile = () => {
    try {
      addVSCodeFileAttachment(filePath, fileName, fileSize);
    } catch (error) {
      if (error instanceof Error) toast.error(error.message);
    }
  };

  const handlePinSelection = async () => {
    if (!selection) return;
    const blob = new Blob([selection.text], { type: 'text/plain' });
    const file = new File([blob], selectionLabel, { type: 'text/plain' });
    await addVSCodeSelectionAttachment(filePath, file);
  };

  const showSelectionPin = !!selection && !isSelectionAttached;
  const showFileAdd = !showSelectionPin && !isFileAttached;

  if (!showSelectionPin && !showFileAdd) return null;

  return (
    <div className="inline-flex items-center">
      {showSelectionPin && (
        <div
          className="inline-flex items-center gap-1 text-xs pe-1 rounded-sm italic text-muted-foreground border border-dashed bg-transparent"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('chat.fileAttachment.activeEditor.pinSelection')}
                onClick={() => { void handlePinSelection(); }}
                className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
              >
                <Icon name="pushpin-2" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('chat.fileAttachment.activeEditor.pinSelection')}</TooltipContent>
          </Tooltip>
          <FileTypeIcon filePath={fileName} extension={ext} className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs whitespace-nowrap" title={relativePath}>{`${displayName}:${selectionRange}`}</span>
        </div>
      )}
      {showFileAdd && (
        <div
          className="inline-flex items-center gap-1 text-xs pe-1 rounded-sm italic text-muted-foreground border border-dashed bg-transparent"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('chat.fileAttachment.activeEditor.addFile', { name: displayName })}
                onClick={handleAddFile}
                className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
              >
                <Icon name="add" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t('chat.fileAttachment.activeEditor.addFile', { name: displayName })}</TooltipContent>
          </Tooltip>
          <FileTypeIcon filePath={fileName} extension={ext} className="h-4 w-4 flex-shrink-0" />
          <span className="text-xs truncate max-w-[220px]" title={relativePath}>{displayName}</span>
        </div>
      )}
    </div>
  );
});

ActiveEditorFileSuggestion.displayName = 'ActiveEditorFileSuggestion';

interface FilePart {
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
  source?: Record<string, unknown>;
}

const issueLinkIcon = (kind: Exclude<IssueLinkKind, 'repository-issue' | 'tracker-item'>): 'git-pull-request' | 'attachment-2' => (
  kind === 'guest-issue' ? 'attachment-2' : 'git-pull-request'
);

const IssueLinkIcon: React.FC<{ file: { mime?: string }; kind: IssueLinkKind; className?: string }> = ({ file, kind, className }) => {
  const provider = useSourceControlProvider(getRepositoryIssueLinkProvider(file));
  if (kind === 'repository-issue') return <ProviderIcon descriptor={provider} className={className} />;
  if (kind === 'tracker-item') return <Icon name={trackerPresentation(getTrackerItemLinkProvider(file)).icon} className={className} />;
  return <Icon name={issueLinkIcon(kind)} className={className} />;
};

interface MessageFilesDisplayProps {
  files: FilePart[];
  onShowPopup?: (content: ToolPopupContent) => void;
  compact?: boolean;
  className?: string;
}

export const MessageFilesDisplay = memo(({ files, onShowPopup, compact = false, className }: MessageFilesDisplayProps) => {
  const { t } = useI18n();
  const openAttachment = useOpenAttachment(onShowPopup);

  const fileItems = files.filter(f => f.type === 'file' && (f.mime || f.url));

  const extractFilename = (path?: string): string => {
    if (!path) return 'Unnamed file';

    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];

    return filename || path;
  };

  const resolveDisplayName = React.useCallback((file: FilePart): string => {
    const isIssueLink = getIssueLinkKind(file) !== null;
    if (isIssueLink && typeof file.filename === 'string' && file.filename.trim().length > 0) {
      return file.filename.trim();
    }
    return extractFilename(file.filename || file.url);
  }, []);


  const resolveOpenTarget = (file: FilePart) => {
    const target = resolveAttachmentOpenTarget(file, fileItems);
    return target?.kind === 'popup' && !onShowPopup ? null : target;
  };

  const showFilePopup = React.useCallback((file: FilePart, fileName: string) => {
    if (!onShowPopup || !file.url) {
      return;
    }

    const target = resolveAttachmentOpenTarget(file, [file]);
    if (target?.kind === 'popup' && !target.popup.image) {
      onShowPopup({ ...target.popup, title: fileName });
      return;
    }

    onShowPopup({
      open: true,
      title: fileName,
      content: '',
      image: {
        url: file.url,
        mimeType: file.mime,
        filename: fileName,
      },
    });
  }, [onShowPopup]);

  if (fileItems.length === 0) return null;

  if (compact) {
    const tileClass = 'relative flex-none snap-start h-16 rounded-lg overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-ring';
    return (
      <ScrollableOverlay outerClassName={cn('overlay-scrollbar-wrapper--no-gutter -mx-1 w-auto', className ?? 'mt-1.5')} className="px-1 py-0.5" fillContainer={false}>
        <div className="flex snap-x snap-mandatory gap-1.5">
          {fileItems.map((file, index) => {
            const fileName = resolveDisplayName(file) || 'File';
            const openTarget = resolveOpenTarget(file);
            const issueLinkKind = getIssueLinkKind(file);
            const isImage = Boolean(file.mime?.startsWith('image/') && file.url) && !issueLinkKind;
            const sizeText = formatFileSize(file.size);
            const ext = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
            const kindText = [issueLinkKind ? null : ext.toUpperCase() || null, sizeText || null].filter(Boolean).join(' · ');
            const open = openTarget
              ? (event: React.MouseEvent) => openAttachment(openTarget, issueLinkKind ? event : undefined)
              : undefined;
            return (
              <Tooltip key={`attachment-${file.url || file.filename || index}`}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={open}
                    disabled={!open}
                    aria-label={fileName}
                    className={cn(tileClass, isImage
                      ? 'w-16 bg-muted/10 cursor-zoom-in'
                      : 'oc-tile flex w-36 flex-col justify-between px-2 py-1 text-start enabled:hover:text-foreground disabled:cursor-default')}
                  >
                    {isImage && file.url ? (
                      <StatusImage
                        src={file.url}
                        alt={fileName}
                        variant="thumbnail"
                        className="absolute inset-0 h-full w-full"
                        imgClassName="h-full w-full object-cover"
                        lazy
                      />
                    ) : (
                      <>
                        <span dir="auto" className="line-clamp-2 [overflow-wrap:anywhere] typography-meta leading-tight text-foreground">{fileName}</span>
                        <span className="flex min-w-0 items-center gap-1">
                          {issueLinkKind ? (
                            <IssueLinkIcon file={file} kind={issueLinkKind} className="h-3 w-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <FileTypeIcon filePath={fileName} extension={ext} className="h-3 w-3 shrink-0" />
                          )}
                          {kindText ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{kindText}</span> : null}
                        </span>
                      </>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="typography-meta px-2 py-1">
                  {fileName}{sizeText ? ` (${sizeText})` : ''}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </ScrollableOverlay>
    );
  }

  return (
    <div className={cn(
      "grid gap-2",
      compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
    )}>
      {fileItems.map((file, index) => {
        const fileName = resolveDisplayName(file);
        const isImage = file.mime?.startsWith('image/');
        const sizeText = formatFileSize(file.size);
        const issueLinkKind = getIssueLinkKind(file);

        if (isImage && file.url) {
          return (
            <div
              key={file.url || `${fileName}-${index}`}
              className="relative aspect-video rounded-lg border border-edge-muted bg-muted/10 overflow-hidden group"
            >
              <StatusImage
                src={file.url}
                alt={fileName}
                variant="thumbnail"
                className="h-full w-full"
                imgClassName="h-full w-full object-cover"
                lazy
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="absolute bottom-0 inset-s-0 inset-e-0 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-xs font-medium truncate">{fileName}</p>
                {sizeText && <p className="text-xs opacity-80">{sizeText}</p>}
              </div>
            </div>
          );
        }

        if (issueLinkKind && file.url) {
          const issueUrl = file.url;
          return (
            <Tooltip key={file.url || `${fileName}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => openAttachment({ kind: 'external', url: issueUrl }, event)}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg oc-tile oc-tile-hover text-start",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <div className="flex-shrink-0">
                    <IssueLinkIcon file={file} kind={issueLinkKind} className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        const source = file.source;
        const sourceType = typeof source?.type === 'string' ? source.type : undefined;
        const sourcePath = source && typeof (source as Record<string, unknown>).path === 'string' ? (source as Record<string, unknown>).path as string : undefined;
        const filePath = sourceType === 'file' && sourcePath ? sourcePath : (file.url || '');
        const opensInDiagramEditor = filePath && (isDrawioFile(filePath) || isExcalidrawFile(filePath));

        if (opensInDiagramEditor) {
          return (
            <Tooltip key={file.url || `${fileName}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    const directory = useDirectoryStore.getState().currentDirectory;
                    if (directory) {
                      useUIStore.getState().openContextFile(directory, filePath);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg oc-tile oc-tile-hover text-start cursor-pointer",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <Icon name="file" className={cn("text-muted-foreground shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    <p className="text-xs text-status-info">{t('chat.fileAttachment.openInDiagram')}</p>
                  </div>
                  <Icon name="external-link" className={cn("text-muted-foreground shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('chat.fileAttachment.openInDiagram')}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={file.url || `${fileName}-${index}`}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  showFilePopup(file, fileName);
                }}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-lg oc-tile oc-tile-hover text-start",
                  compact ? "text-xs" : "text-sm"
                )}
              >
                <div className="flex-shrink-0">
                  {file.mime?.startsWith('image/') ? (
                    <Icon name="file-image" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : file.mime?.includes('pdf') ? (
                    <Icon name="file-pdf" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : (
                    <Icon name="file" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{fileName}</p>
                  {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
});

MessageFilesDisplay.displayName = 'MessageFilesDisplay';

interface ImageGalleryProps {
  urls: string[];
  caption?: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const ImageGallery = memo(({ urls, caption, onShowPopup }: ImageGalleryProps) => {
  if (urls.length === 0) return null;

  const getGridCols = () => {
    if (urls.length === 1) return 'grid-cols-1';
    if (urls.length === 2) return 'grid-cols-2';
    if (urls.length <= 4) return 'grid-cols-2';
    return 'grid-cols-3';
  };

  return (
    <div className="space-y-2">
      <div className={cn("grid gap-2", getGridCols())}>
        {urls.map((url, index) => (
          <button
            key={url}
            type="button"
            onClick={() => onShowPopup?.({
              open: true,
              title: caption || `Image ${index + 1} of ${urls.length}`,
              content: '',
              image: {
                url,
                gallery: urls.map(u => ({ url: u })),
                index,
              },
            })}
            className="relative aspect-square rounded-lg border border-edge-muted bg-muted/10 overflow-hidden group"
          >
            <img
              src={url}
              alt={caption || `Image ${index + 1}`}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
          </button>
        ))}
      </div>
      {caption && (
        <p className="text-sm text-muted-foreground italic">{caption}</p>
      )}
    </div>
  );
});

ImageGallery.displayName = 'ImageGallery';
