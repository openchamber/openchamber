import React, { useRef, memo } from 'react';
import { RiAttachment2, RiCloseLine, RiFileImageLine, RiFileLine, RiFilePdfLine, RiGithubLine, RiGitPullRequestLine } from '@remixicon/react';
import { useInputStore } from '@/sync/input-store';
import type { AttachedFile } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

import type { ToolPopupContent } from './message/types';

export const FileAttachmentButton = memo(() => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const isMobile = useUIStore((state) => state.isMobile);
  const isVSCodeRuntime = useIsVSCodeRuntime();
  const buttonSizeClass = isMobile ? 'h-9 w-9' : 'h-7 w-7';
  const iconSizeClass = isMobile ? 'h-5 w-5' : 'h-[18px] w-[18px]';

  const attachFiles = async (files: FileList | File[]) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await addAttachedFile(file);
      } catch (error) {
        console.error('File attach failed', error);
        toast.error(error instanceof Error ? error.message : 'Failed to attach file');
      }
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
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={isVSCodeRuntime ? handleVSCodePick : () => fileInputRef.current?.click()}
            className={cn(
              'flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'hover:bg-muted text-muted-foreground',
              buttonSizeClass
            )}
            aria-label="Attach files"
          >
            <RiAttachment2 className={iconSizeClass} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Attach files</p>
        </TooltipContent>
      </Tooltip>
    </>
  );
});

FileAttachmentButton.displayName = 'FileAttachmentButton';

interface ImagePreviewProps {
  file: AttachedFile;
  onRemove: () => void;
}

const ImagePreview = memo(({ file, onRemove }: ImagePreviewProps) => {
  const isLocalImagePreview =
    file.source !== 'server' &&
    file.mimeType.startsWith('image/') &&
    typeof file.dataUrl === 'string' &&
    file.dataUrl.startsWith('data:image/');

  const imageUrl = isLocalImagePreview ? file.dataUrl : (file.serverPath || '');

  const extractFilename = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || path;
  };

  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  };

  const displayName = extractFilename(file.filename);
  const extension = getFileExtension(file.filename);

  if (!imageUrl) {
    // Fallback to text-only for server images without preview
    return (
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5"
      >
        <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4" />
        <span className="text-foreground truncate max-w-[200px]">
          {displayName}
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
          aria-label={`Remove ${displayName}`}
        >
          <RiCloseLine className="h-4 w-4 text-muted-foreground" />
        </span>
      </button>
    );
  }

  return (
    <div className="relative h-10 w-10 rounded-lg border border-border/40 bg-muted/10 overflow-hidden flex-shrink-0 group">
      <img
        src={imageUrl}
        alt={displayName}
        className="h-full w-full object-cover"
        loading="lazy"
      />
      <button
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-background/80 text-foreground hover:text-destructive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title="Remove image"
        aria-label={`Remove ${displayName}`}
      >
        <RiCloseLine className="h-2.5 w-2.5" />
      </button>
    </div>
  );
});

ImagePreview.displayName = 'ImagePreview';

interface FileChipProps {
  file: AttachedFile;
  onRemove: () => void;
}

const FileChip = memo(({ file, onRemove }: FileChipProps) => {
  const getFileExtension = (filename: string): string => {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  };

  const formatFileSize = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
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
  const fileSize = formatFileSize(file.size);
  const extension = getFileExtension(file.filename);

  return (
    <button
      type="button"
      onClick={(e) => {
        // Prevent click from bubbling if clicking the remove button
        if ((e.target as HTMLElement).closest('[data-remove-button]')) {
          return;
        }
      }}
      className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5"
    >
      <FileTypeIcon filePath={file.filename} extension={extension} className="h-4 w-4" />
      <span className="text-foreground truncate max-w-[200px]">
        {displayName}
        {fileSize && <span className="text-muted-foreground ml-1">({fileSize})</span>}
      </span>
      <span
        data-remove-button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="flex items-center justify-center h-5 w-5 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
        aria-label={`Remove ${displayName}`}
      >
        <RiCloseLine className="h-4 w-4 text-muted-foreground" />
      </span>
    </button>
  );
});

FileChip.displayName = 'FileChip';

export const AttachedFilesList = memo(() => {
  const attachedFiles = useInputStore((state) => state.attachedFiles);
  const removeAttachedFile = useInputStore((state) => state.removeAttachedFile);

  const localFiles = attachedFiles.filter((file) => file.source !== 'server');

  if (localFiles.length === 0) return null;

  const images = localFiles.filter((f) => f.mimeType.startsWith('image/'));
  const otherFiles = localFiles.filter((f) => !f.mimeType.startsWith('image/'));

  return (
    <div className="pb-4 w-full px-1 space-y-3">
      {/* Images row - inline with previews */}
      {images.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {images.map((file) => (
            <ImagePreview
              key={file.id}
              file={file}
              onRemove={() => removeAttachedFile(file.id)}
            />
          ))}
        </div>
      )}
      
      {/* Other files row - inline text-only */}
      {otherFiles.length > 0 && (
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          {otherFiles.map((file) => (
            <FileChip
              key={file.id}
              file={file}
              onRemove={() => removeAttachedFile(file.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

AttachedFilesList.displayName = 'AttachedFilesList';

interface FilePart {
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
}

const GITHUB_ISSUE_LINK_MIME = 'application/vnd.github.issue-link';
const GITHUB_PR_LINK_MIME = 'application/vnd.github.pull-request-link';

const getGitHubLinkKind = (file: FilePart): 'issue' | 'pr' | null => {
  if (file.mime === GITHUB_ISSUE_LINK_MIME) {
    return 'issue';
  }
  if (file.mime === GITHUB_PR_LINK_MIME) {
    return 'pr';
  }
  return null;
};

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
    const filename = parts[parts.length - 1];

    return filename || path;
  };

  const resolveDisplayName = React.useCallback((file: FilePart): string => {
    const isGitHubLink = getGitHubLinkKind(file) !== null;
    if (isGitHubLink && typeof file.filename === 'string' && file.filename.trim().length > 0) {
      return file.filename.trim();
    }
    return extractFilename(file.filename || file.url);
  }, []);

  const formatFileSize = (bytes?: number) => {
    if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const imageFiles = fileItems.filter(f => f.mime?.startsWith('image/') && f.url);
  const otherFiles = fileItems.filter(f => !f.mime?.startsWith('image/'));

  const imageGallery = React.useMemo(
    () =>
      imageFiles.flatMap((file) => {
        if (!file.url) return [];
        const filename = resolveDisplayName(file) || 'Image';
        return [{
          url: file.url,
          mimeType: file.mime,
          filename,
          size: file.size,
        }];
      }),
    [imageFiles, resolveDisplayName]
  );

  const handleImageClick = React.useCallback((index: number) => {
    if (!onShowPopup) {
      return;
    }

    const file = imageGallery[index];
    if (!file?.url) return;

    const filename = file.filename || 'Image';

    onShowPopup({
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
    });
  }, [imageGallery, onShowPopup]);

  if (fileItems.length === 0) return null;

  if (compact) {
    return (
      <div className="space-y-1.5 mt-1.5">
        {otherFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {otherFiles.map((file, index) => {
              const fileName = resolveDisplayName(file);
              const sizeText = formatFileSize(file.size);
              const githubLinkKind = getGitHubLinkKind(file);
              return (
                <Tooltip key={`file-${file.url || file.filename || index}`}>
                  <TooltipTrigger asChild>
                    {githubLinkKind && file.url ? (
                      <button
                        type="button"
                        onClick={() => {
                          void openExternalUrl(file.url || '');
                        }}
                        className="inline-flex items-center bg-muted/30 border border-border/30 typography-meta gap-1 px-2 py-0.5 rounded-lg text-foreground hover:text-primary transition-colors"
                      >
                        {githubLinkKind === 'pr' ? (
                          <RiGitPullRequestLine className="text-muted-foreground h-3.5 w-3.5" />
                        ) : (
                          <RiGithubLine className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                        <div className="overflow-hidden max-w-[220px]">
                          <span className="truncate block" title={fileName}>{fileName}</span>
                        </div>
                      </button>
                    ) : (
                      <div className="inline-flex items-center bg-muted/30 border border-border/30 typography-meta gap-1 px-2 py-0.5 rounded-lg">
                        {file.mime?.includes('pdf') ? (
                          <RiFilePdfLine className="text-muted-foreground h-3.5 w-3.5" />
                        ) : (
                          <RiFileLine className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                        <div className="overflow-hidden max-w-[140px]">
                          <span className="truncate block" title={fileName}>{fileName}</span>
                        </div>
                      </div>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}

        {imageFiles.length > 0 && (
          <div className="overflow-x-auto -mx-1 px-1 py-0.5 scrollbar-thin">
            <div className="flex snap-x snap-mandatory gap-2">
              {imageFiles.map((file, index) => {
                const filename = resolveDisplayName(file) || 'Image';

                return (
                  <Tooltip key={`img-${file.url || file.filename || index}`} delayDuration={1000}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => handleImageClick(index)}
                        className="relative flex-none border border-border/40 bg-muted/10 overflow-hidden snap-start h-12 w-12 sm:h-14 sm:w-14 md:h-16 md:w-16 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-primary"
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
        const githubLinkKind = getGitHubLinkKind(file);

        if (isImage && file.url) {
          return (
            <div
              key={index}
              className="relative aspect-video rounded-lg border border-border/40 bg-muted/10 overflow-hidden group"
            >
              <img
                src={file.url}
                alt={fileName}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="absolute bottom-0 left-0 right-0 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-xs font-medium truncate">{fileName}</p>
                {sizeText && <p className="text-xs opacity-80">{sizeText}</p>}
              </div>
            </div>
          );
        }

        if (githubLinkKind && file.url) {
          return (
            <Tooltip key={index}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    void openExternalUrl(file.url || '');
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <div className="flex-shrink-0">
                    {githubLinkKind === 'pr' ? (
                      <RiGitPullRequestLine className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                    ) : (
                      <RiGithubLine className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
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
        }

        return (
          <Tooltip key={index}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (onShowPopup && file.url) {
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
                  }
                }}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left",
                  compact ? "text-xs" : "text-sm"
                )}
              >
                <div className="flex-shrink-0">
                  {file.mime?.startsWith('image/') ? (
                    <RiFileImageLine className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : file.mime?.includes('pdf') ? (
                    <RiFilePdfLine className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : (
                    <RiFileLine className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
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

export const ImageGallery = memo(({ urls, caption, onShowPopup }: ImageGalleryProps) => {
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
            key={index}
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
            className="relative aspect-square rounded-lg border border-border/40 bg-muted/10 overflow-hidden group"
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
