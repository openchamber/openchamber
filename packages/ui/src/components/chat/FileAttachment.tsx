import React, { useRef, memo } from 'react';
import { RiAttachment2, RiCloseLine, RiComputerLine, RiFileImageLine, RiFileLine, RiFilePdfLine, RiHardDrive3Line } from '@remixicon/react';
import { useSessionStore, type AttachedFile } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';

import type { ToolPopupContent } from './message/types';

export const FileAttachmentButton = memo(() => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { addAttachedFile } = useSessionStore();
  const { isMobile } = useUIStore();
  const isVSCodeRuntime = useIsVSCodeRuntime();
  const buttonSizeClass = isMobile ? 'h-9 w-9' : 'h-7 w-7';
  const iconSizeClass = isMobile ? 'h-5 w-5' : 'h-[18px] w-[18px]';

  const attachFiles = async (files: FileList | File[]) => {
    let attachedCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sizeBefore = useSessionStore.getState().attachedFiles.length;
      try {
        await addAttachedFile(file);
        const sizeAfter = useSessionStore.getState().attachedFiles.length;
        if (sizeAfter > sizeBefore) {
          attachedCount++;
        }
      } catch (error) {
        console.error('File attach failed', error);
        toast.error(error instanceof Error ? error.message : 'Failed to attach file');
      }
    }
    if (attachedCount > 0) {
      toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    await attachFiles(files);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleVSCodePick = async () => {
    try {
      const response = await fetch('/api/vscode/pick-files');
      const data = await response.json();
      const picked = Array.isArray(data?.files) ? data.files : [];
      const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

      if (skipped.length > 0) {
        const summary = skipped.map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`).join('\n');
        toast.error(`Some files were skipped:\n${summary}`);
      }

      const asFiles = picked
        .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
          if (!file?.dataUrl) return null;
          try {
            const [meta, base64] = file.dataUrl.split(',');
            const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
            if (!base64) return null;
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: mime });
            return new File([blob], file.name || 'file', { type: mime });
          } catch (err) {
            console.error('Failed to decode VS Code picked file', err);
            return null;
          }
        })
        .filter(Boolean) as File[];

      if (asFiles.length > 0) {
        await attachFiles(asFiles);
      }
    } catch (error) {
      console.error('VS Code file pick failed', error);
      toast.error(error instanceof Error ? error.message : 'Failed to pick files in VS Code');
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        accept="*/*"
      />
      <button
        type='button'
        onClick={() => {
          if (isVSCodeRuntime) {
            void handleVSCodePick();
          } else {
            fileInputRef.current?.click();
          }
        }}
        className={cn(
          buttonSizeClass,
          'flex items-center justify-center text-muted-foreground transition-none outline-none focus:outline-none flex-shrink-0'
        )}
        title='Attach files'
      >
        <RiAttachment2 className={cn(iconSizeClass, 'text-current')} />
      </button>
    </>
  );
});

interface FileChipProps {
  file: AttachedFile;
  onRemove: () => void;
}

const FileChip = memo(({ file, onRemove }: FileChipProps) => {
  const getFileIcon = () => {
    if (file.mimeType.startsWith('image/')) {
      return <RiFileImageLine className="h-3.5 w-3.5" />;
    }
    if (file.mimeType.includes('text') || file.mimeType.includes('code')) {
      return <RiFileLine className="h-3.5 w-3.5" />;
    }
    if (file.mimeType.includes('json') || file.mimeType.includes('xml')) {
      return <RiFilePdfLine className="h-3.5 w-3.5" />;
    }
    return <RiFileLine className="h-3.5 w-3.5" />;
  };

  const formatFileSize = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '...';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const extractFilename = (path: string): string => {

    const normalized = path.replace(/\\/g, '/');

    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];

    return filename || path;
  };

  const displayName = extractFilename(file.filename);
  const isLocalImagePreview =
    file.source !== 'server' &&
    file.mimeType.startsWith('image/') &&
    typeof file.dataUrl === 'string' &&
    file.dataUrl.startsWith('data:image/');

  if (isLocalImagePreview) {
    return (
      <div className="relative h-12 w-12 sm:h-14 sm:w-14 overflow-hidden rounded-lg border border-border/40 bg-muted/10 flex-shrink-0">
        <img
          src={file.dataUrl}
          alt={displayName}
          className="h-full w-full object-cover"
          loading="lazy"
        />
        <button
          onClick={onRemove}
          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-background/80 text-foreground hover:text-destructive flex items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title="Remove image"
          aria-label={`Remove ${displayName}`}
        >
          <RiCloseLine className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full sm:inline-flex sm:w-auto items-center gap-1.5 px-3 sm:px-2.5 py-1 bg-muted/30 border border-border/30 rounded-xl typography-meta max-w-full min-w-0">
      <div title={file.source === 'server' ? "Server file" : "Local file"}>
        {file.source === 'server' ? (
          <RiHardDrive3Line className="h-3 w-3 text-primary flex-shrink-0" />
        ) : (
          <RiComputerLine className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        )}
      </div>
      {getFileIcon()}
      <div className="overflow-hidden max-w-[120px] sm:max-w-[180px] flex-1 min-w-0">
        <span className="truncate block" title={file.serverPath || displayName}>
          {displayName}
        </span>
      </div>
      <span className="ml-auto text-muted-foreground flex-shrink-0 text-xs">
        {formatFileSize(file.size)}
      </span>
      <button
        onClick={onRemove}
        className="hover:text-destructive min-h-6 min-w-6 sm:min-h-0 sm:min-w-0 sm:p-0.5 flex items-center justify-center flex-shrink-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title="Remove file"
      >
        <RiCloseLine className="h-4 w-4 sm:h-3 sm:w-3" />
      </button>
    </div>
  );
});

export const AttachedFilesList = memo(() => {
  const { attachedFiles, removeAttachedFile } = useSessionStore();

  if (attachedFiles.length === 0) return null;

  return (
    <div className="pb-2 overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-2 px-3 py-2 bg-muted/30 rounded-xl border border-border/30">
        {attachedFiles.map((file) => (
          <FileChip
            key={file.id}
            file={file}
            onRemove={() => removeAttachedFile(file.id)}
          />
        ))}
      </div>
    </div>
  );
});

interface FilePart {
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
}

interface MessageFilesDisplayProps {
  files: FilePart[];
  onShowPopup?: (content: ToolPopupContent) => void;
  compact?: boolean;
}

export const MessageFilesDisplay = memo(({ files, onShowPopup, compact = false }: MessageFilesDisplayProps) => {

  const fileItems = files.filter(f => f.type === 'file' && (f.mime || f.url));

  const extractFilename = (path?: string): string => {
    if (!path) return 'Unnamed file';

    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || path;
  };

  const getFileIcon = (mimeType?: string) => {
    if (!mimeType) return <RiFileLine className="h-3.5 w-3.5" />;

    if (mimeType.startsWith('image/')) {
      return <RiFileImageLine className="h-3.5 w-3.5" />;
    }
    if (mimeType.includes('text') || mimeType.includes('code')) {
      return <RiFileLine className="h-3.5 w-3.5" />;
    }
    if (mimeType.includes('json') || mimeType.includes('xml')) {
      return <RiFilePdfLine className="h-3.5 w-3.5" />;
    }
    return <RiFileLine className="h-3.5 w-3.5" />;
  };

  const extractExtension = (value?: string): string => {
    if (!value) return '';
    const normalized = value.replace(/\\/g, '/').trim();
    const filename = normalized.split('/').pop() || normalized;
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex < 0) return '';
    return filename.slice(dotIndex).toLowerCase();
  };

  const isMermaidMimeType = (mimeType?: string): boolean => {
    if (!mimeType) return false;
    const normalized = mimeType.toLowerCase();
    return normalized === 'text/vnd.mermaid'
      || normalized === 'application/vnd.mermaid'
      || normalized === 'text/x-mermaid'
      || normalized === 'application/x-mermaid';
  };

  const isGenericTextOrUnknownMime = (mimeType?: string): boolean => {
    if (!mimeType) return true;
    const normalized = mimeType.toLowerCase();
    return normalized === 'text/plain' || normalized === 'application/octet-stream';
  };

  const isExplicitBinaryMime = (mimeType?: string): boolean => {
    if (!mimeType) return false;
    const normalized = mimeType.toLowerCase();
    return normalized.startsWith('image/')
      || normalized.startsWith('video/')
      || normalized.startsWith('audio/')
      || normalized === 'application/pdf';
  };

  const isMermaidFile = (file: FilePart): boolean => {
    const normalizedMime = file.mime?.toLowerCase();
    if (isMermaidMimeType(normalizedMime)) {
      return true;
    }

    if (isExplicitBinaryMime(normalizedMime)) {
      return false;
    }

    const extension = extractExtension(file.filename || file.url);
    const isMermaidExtension = extension === '.mmd' || extension === '.mermaid';
    return isMermaidExtension && isGenericTextOrUnknownMime(normalizedMime);
  };

  const imageFiles = fileItems.filter(f => f.mime?.startsWith('image/') && f.url);
  const mermaidFiles = fileItems.filter((file) => isMermaidFile(file) && file.url);
  const otherFiles = fileItems.filter((file) => {
    if (file.mime?.startsWith('image/')) {
      return false;
    }
    return !isMermaidFile(file);
  });

  const imageGallery = React.useMemo(
    () =>
      imageFiles.flatMap((file) => {
          if (!file.url) return [];
          const filename = extractFilename(file.filename) || 'Image';
          return [{
            url: file.url,
            mimeType: file.mime,
            filename,
            size: file.size,
          }];
        }),
    [imageFiles]
  );

  const handleImageClick = React.useCallback((index: number) => {
    if (!onShowPopup) {
      return;
    }

    const file = imageGallery[index];
    if (!file?.url) return;

    const filename = file.filename || 'Image';

    const popupPayload: ToolPopupContent = {
      open: true,
      title: filename,
      content: '',
      metadata: {
        tool: 'image-preview',
        filename,
        mime: file.mimeType,
        size: file.size,
      },
      image: {
        url: file.url,
        mimeType: file.mimeType,
        filename,
        size: file.size,
        gallery: imageGallery,
        index,
      },
    };

    onShowPopup(popupPayload);
  }, [imageGallery, onShowPopup]);

  const handleMermaidClick = React.useCallback((file: FilePart) => {
    if (!onShowPopup || !file.url) {
      return;
    }

    const filename = extractFilename(file.filename) || 'Diagram';
    onShowPopup({
      open: true,
      title: filename,
      content: '',
      metadata: {
        tool: 'mermaid-preview',
        filename,
        mime: file.mime,
        size: file.size,
      },
      mermaid: {
        url: file.url,
        mimeType: file.mime,
        filename,
      },
    });
  }, [onShowPopup]);

  if (fileItems.length === 0) return null;

  return (
    <div className={cn(compact ? 'space-y-1.5 mt-1.5' : 'space-y-2 mt-2')}>
      {}
      {otherFiles.length > 0 && (
        <div className={cn('flex flex-wrap', compact ? 'gap-1.5' : 'gap-2')}>
          {otherFiles.map((file, index) => (
            <div
              key={`file-${file.url || file.filename || index}`}
              className={cn(
                'inline-flex items-center bg-muted/30 border border-border/30 typography-meta',
                compact ? 'gap-1 px-2 py-0.5 rounded-lg' : 'gap-1.5 px-2.5 py-1 rounded-xl'
              )}
            >
              {getFileIcon(file.mime)}
              <div className={cn('overflow-hidden', compact ? 'max-w-[140px]' : 'max-w-[200px]')}>
                <span className="truncate block" title={extractFilename(file.filename)}>
                  {extractFilename(file.filename)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {mermaidFiles.length > 0 && (
        <div className={cn('flex flex-wrap', compact ? 'gap-1.5' : 'gap-2')}>
          {mermaidFiles.map((file, index) => {
            const filename = extractFilename(file.filename) || 'Diagram';

            return (
              <button
                key={`mermaid-${file.url || file.filename || index}`}
                type="button"
                onClick={() => handleMermaidClick(file)}
                className={cn(
                  'inline-flex items-center bg-muted/30 border border-border/30 typography-meta transition-colors',
                  'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
                  compact ? 'gap-1 px-2 py-0.5 rounded-lg' : 'gap-1.5 px-2.5 py-1 rounded-xl'
                )}
                title={`Open ${filename}`}
                aria-label={`Open diagram ${filename}`}
              >
                {getFileIcon(file.mime)}
                <div className={cn('overflow-hidden', compact ? 'max-w-[140px]' : 'max-w-[200px]')}>
                  <span className="truncate block" title={filename}>
                    {filename}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {}
      {imageFiles.length > 0 && (
        <div className={cn('overflow-x-auto -mx-1 px-1 scrollbar-thin', compact ? 'py-0.5' : 'py-1')}>
          <div className={cn('flex snap-x snap-mandatory', compact ? 'gap-2' : 'gap-3')}>
            {imageFiles.map((file, index) => {
    const filename = extractFilename(file.filename) || 'Image';

              return (
                <Tooltip key={`img-${file.url || file.filename || index}`} delayDuration={1000}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => handleImageClick(index)}
                      className={cn(
                        'relative flex-none border border-border/40 bg-muted/10 overflow-hidden snap-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-primary',
                        compact
                          ? 'h-12 w-12 sm:h-14 sm:w-14 md:h-16 md:w-16 rounded-lg'
                          : 'aspect-square w-16 sm:w-20 md:w-24 rounded-xl'
                      )}
                      aria-label={filename}
                    >
                      {file.url ? (
                        <img
                          src={file.url}
                          alt={filename}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.visibility = 'hidden';
                          }}
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center bg-muted/30 text-muted-foreground">
                          <RiFileImageLine className="h-6 w-6" />
                        </div>
                      )}
                      <span className="sr-only">{filename}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6} className="typography-meta px-2 py-1">
                    {filename}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
