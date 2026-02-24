import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { RiCheckLine, RiClipboardLine, RiDownloadCloudLine, RiDownloadLine, RiExternalLinkLine, RiLoaderLine, RiRestartLine, RiTerminalLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { UpdateInfo, UpdateProgress } from '@/lib/desktop';
import { copyTextToClipboard } from '@/lib/clipboard';

type WebUpdateState = 'idle' | 'updating' | 'restarting' | 'reconnecting' | 'error';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: UpdateInfo | null;
  downloading: boolean;
  downloaded: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  onDownload: () => void;
  onRestart: () => void;
  /** Runtime type to show different UI for desktop vs web */
  runtimeType?: 'desktop' | 'web' | 'vscode' | null;
}

const GITHUB_RELEASES_URL = 'https://github.com/btriapitsyn/openchamber/releases';

type ChangelogSection = {
  version: string;
  date: string;
  start: number;
  end: number;
  raw: string;
};

type ParsedChangelog =
  | {
      kind: 'raw';
      title: string;
      content: string;
    }
  | {
      kind: 'sections';
      title: string;
      sections: Array<{ version: string; dateLabel: string; content: string }>;
    };

function formatIsoDateForUI(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    return isoDate;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function stripChangelogHeading(sectionRaw: string): string {
  return sectionRaw.replace(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*\n?/, '').trim();
}

function processChangelogMentions(content: string): string {
  // Convert @username to markdown links so they can be styled via css
  return content.replace(/(^|[^a-zA-Z0-9])@([a-zA-Z0-9-]+)/g, '$1[@$2](https://github.com/$2)');
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split('.').map((v) => Number.parseInt(v, 10));
  const pb = b.split('.').map((v) => Number.parseInt(v, 10));
  for (let i = 0; i < 3; i += 1) {
    const da = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const db = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (da !== db) {
      return db - da;
    }
  }
  return 0;
}

function parseChangelogSections(body: string): ChangelogSection[] {
  const re = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  const matches: Array<{ version: string; date: string; start: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    matches.push({
      version: m[1] ?? '',
      date: m[2] ?? '',
      start: m.index,
    });
  }

  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, idx) => {
    const end = matches[idx + 1]?.start ?? body.length;
    const raw = body.slice(match.start, end).trim();
    return { version: match.version, date: match.date, start: match.start, end, raw };
  });
}


async function installWebUpdate(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch('/api/openchamber/update-install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { success: false, error: data.error || `Server error: ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to install update' };
  }
}

async function waitForServerRestart(maxAttempts = 30, intervalMs = 2000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch('/health', { method: 'GET' });
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  open,
  onOpenChange,
  info,
  downloading,
  downloaded,
  progress,
  error,
  onDownload,
  onRestart,
  runtimeType = 'desktop',
}) => {
  const [copied, setCopied] = useState(false);
  const [webUpdateState, setWebUpdateState] = useState<WebUpdateState>('idle');
  const [webError, setWebError] = useState<string | null>(null);

  const releaseUrl = info?.version
    ? `${GITHUB_RELEASES_URL}/tag/v${info.version}`
    : GITHUB_RELEASES_URL;

  const progressPercent = progress?.total
    ? Math.round((progress.downloaded / progress.total) * 100)
    : 0;

  const isWebRuntime = runtimeType === 'web';
  const updateCommand = info?.updateCommand || 'openchamber update';

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setWebUpdateState('idle');
      setWebError(null);
    }
  }, [open]);

  const handleCopyCommand = async () => {
    const result = await copyTextToClipboard(updateCommand);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenExternal = useCallback(async (url: string) => {
    if (typeof window === 'undefined') return;

    // Try Tauri backend
    type TauriShell = { shell?: { open?: (url: string) => Promise<unknown> } };
    const tauri = (window as unknown as { __TAURI__?: TauriShell }).__TAURI__;
    if (tauri?.shell?.open) {
      try {
        await tauri.shell.open(url);
        return;
      } catch {
        // fall through to window.open
      }
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  }, []);
  const handleWebUpdate = useCallback(async () => {
    setWebUpdateState('updating');
    setWebError(null);

    const result = await installWebUpdate();

    if (!result.success) {
      setWebUpdateState('error');
      setWebError(result.error || 'Update failed');
      return;
    }

    // Server will restart, wait for it to come back
    setWebUpdateState('restarting');

    // Wait a bit for server to shut down
    await new Promise(resolve => setTimeout(resolve, 2000));

    setWebUpdateState('reconnecting');

    const serverBack = await waitForServerRestart();

    if (serverBack) {
      // Reload the page to get the new version
      window.location.reload();
    } else {
      setWebUpdateState('error');
      setWebError('Server did not restart. Please refresh manually or run: openchamber restart');
    }
  }, []);

  const isWebUpdating = webUpdateState !== 'idle' && webUpdateState !== 'error';

  const changelog = useMemo<ParsedChangelog | null>(() => {
    if (!info?.body) {
      return null;
    }

    const body = info.body.trim();
    if (!body) {
      return null;
    }

    const sections = parseChangelogSections(body);

    if (sections.length === 0) {
      return {
        kind: 'raw',
        title: "What's new",
        content: processChangelogMentions(body),
      };
    }

    const sorted = [...sections].sort((a, b) => compareSemverDesc(a.version, b.version));
    return {
      kind: 'sections',
      title: "What's new",
      sections: sorted.map((section) => ({
        version: section.version,
        dateLabel: formatIsoDateForUI(section.date),
        content: processChangelogMentions(stripChangelogHeading(section.raw) || body),
      })),
    };
  }, [info?.body]);

  return (
    <Dialog open={open} onOpenChange={isWebUpdating ? undefined : onOpenChange}>
      <DialogContent className="max-w-4xl p-5 bg-background border-[var(--interactive-border)]" showCloseButton={true}>
        
        {/* Header Section */}
        <div className="flex items-center mb-1">
          <DialogTitle className="flex items-center gap-2.5">
            <RiDownloadCloudLine className="h-5 w-5 text-[var(--primary-base)]" />
            <span className="text-lg font-semibold text-foreground">
              {webUpdateState === 'restarting' || webUpdateState === 'reconnecting'
                ? 'Updating OpenChamber...'
                : 'Update Available'}
            </span>
          </DialogTitle>

          {/* Version Diff */}
          {(info?.currentVersion || info?.version) && (
            <div className="flex items-center gap-2 font-mono text-sm ml-3">
              {info?.currentVersion && (
                <span className="text-muted-foreground">{info.currentVersion}</span>
              )}
              {info?.currentVersion && info?.version && (
                <span className="text-muted-foreground/50">→</span>
              )}
              {info?.version && (
                <span className="text-[var(--primary-base)] font-medium">{info.version}</span>
              )}
            </div>
          )}
        </div>

        {/* Content Body */}
        <div className="space-y-2">

          {/* Web update progress */}
          {isWebRuntime && isWebUpdating && (
            <div className="rounded-lg bg-[var(--surface-elevated)]/30 p-5 border border-[var(--surface-subtle)]">
              <div className="flex items-center gap-3">
                <RiLoaderLine className="h-5 w-5 animate-spin text-[var(--primary-base)]" />
                <div className="typography-ui-label text-foreground">
                  {webUpdateState === 'updating' && 'Installing update...'}
                  {webUpdateState === 'restarting' && 'Server restarting...'}
                  {webUpdateState === 'reconnecting' && 'Waiting for server...'}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                The page will reload automatically when the update is complete.
              </p>
            </div>
          )}

          {/* Changelog Rendering */}
          {changelog && !isWebUpdating && (
            <div className="rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/20 overflow-hidden">
              <ScrollableOverlay
                className="max-h-[400px] p-0"
                fillContainer={false}
              >
                {changelog.kind === 'raw' ? (
                  <div
                    className="p-4 typography-markdown-body text-foreground leading-relaxed break-words [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline hover:[&_a]:!underline"
                    onClickCapture={(e) => {
                      const target = e.target as HTMLElement;
                      const a = target.closest('a');
                      if (a && a.href) {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleOpenExternal(a.href);
                      }
                    }}
                  >
                    <SimpleMarkdownRenderer content={changelog.content} disableLinkSafety={true} />
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--surface-subtle)]">
                    {changelog.sections.map((section) => (
                      <div key={section.version} className="p-4 hover:bg-background/40 transition-colors">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="typography-ui-label font-mono text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-1.5 py-0.5 rounded">
                            v{section.version}
                          </span>
                          <span className="text-sm font-medium text-muted-foreground">
                            {section.dateLabel}
                          </span>
                        </div>
                        <div
                          className="typography-markdown-body text-foreground leading-relaxed break-words [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline hover:[&_a]:!underline"
                          onClickCapture={(e) => {
                            const target = e.target as HTMLElement;
                            const a = target.closest('a');
                            if (a && a.href) {
                              e.preventDefault();
                              e.stopPropagation();
                              void handleOpenExternal(a.href);
                            }
                          }}
                        >
                          <SimpleMarkdownRenderer content={section.content} disableLinkSafety={true} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollableOverlay>
            </div>
          )}

          {/* Web runtime fallback command */}
          {isWebRuntime && webUpdateState === 'error' && (
            <div className="space-y-2 mt-4">
              <div className="flex items-center gap-2 typography-meta text-muted-foreground">
                <RiTerminalLine className="h-4 w-4" />
                <span>Or update via terminal:</span>
              </div>
              <div className="flex items-center gap-2 p-1 pl-3 bg-[var(--surface-elevated)]/50 rounded-md border border-[var(--surface-subtle)]">
                <code className="flex-1 font-mono text-sm text-foreground overflow-x-auto whitespace-nowrap">
                  {updateCommand}
                </code>
                <button
                  onClick={handleCopyCommand}
                  className={cn(
                    'flex items-center justify-center p-2 rounded',
                    'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]',
                    'transition-colors',
                    copied && 'text-[var(--status-success)]'
                  )}
                  title={copied ? 'Copied!' : 'Copy command'}
                >
                  {copied ? (
                    <RiCheckLine className="h-4 w-4" />
                  ) : (
                    <RiClipboardLine className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Desktop progress bar */}
          {!isWebRuntime && downloading && (
            <div className="space-y-2 mt-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Downloading update payload...</span>
                <span className="font-mono text-foreground">{progressPercent}%</span>
              </div>
              <div className="h-1.5 bg-[var(--surface-subtle)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--primary-base)] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Error display */}
          {(error || webError) && (
            <div className="p-3 mt-4 bg-[var(--status-error-background)] border border-[var(--status-error-border)] rounded-lg">
              <p className="text-sm text-[var(--status-error)]">{error || webError}</p>
            </div>
          )}
        </div>

        {/* Action Footer */}
        <div className="mt-4 flex items-center justify-between gap-4">
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <RiExternalLinkLine className="h-4 w-4" />
            GitHub
          </a>

          <div className="flex-1 flex justify-end">
            {/* Desktop Buttons */}
            {!isWebRuntime && !downloaded && !downloading && (
              <button
                onClick={onDownload}
                className="flex items-center justify-center gap-2 px-5 py-2 rounded-md text-sm font-medium bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity"
              >
                <RiDownloadLine className="h-4 w-4" />
                Download Update
              </button>
            )}

            {!isWebRuntime && downloading && (
              <button
                disabled
                className="flex items-center justify-center gap-2 px-5 py-2 rounded-md text-sm font-medium bg-[var(--primary-base)]/50 text-[var(--primary-foreground)] cursor-not-allowed"
              >
                <RiLoaderLine className="h-4 w-4 animate-spin" />
                Downloading...
              </button>
            )}

            {!isWebRuntime && downloaded && (
              <button
                onClick={onRestart}
                className="flex items-center justify-center gap-2 px-5 py-2 rounded-md text-sm font-medium bg-[var(--status-success)] text-white hover:opacity-90 transition-opacity"
              >
                <RiRestartLine className="h-4 w-4" />
                Restart to Update
              </button>
            )}

            {/* Web Buttons */}
            {isWebRuntime && !isWebUpdating && (
              <button
                onClick={handleWebUpdate}
                className="flex items-center justify-center gap-2 px-5 py-2 rounded-md text-sm font-medium bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity"
              >
                <RiDownloadLine className="h-4 w-4" />
                Update Now
              </button>
            )}

            {isWebRuntime && isWebUpdating && (
              <button
                disabled
                className="flex items-center justify-center gap-2 px-5 py-2 rounded-md text-sm font-medium bg-[var(--primary-base)]/50 text-[var(--primary-foreground)] cursor-not-allowed"
              >
                <RiLoaderLine className="h-4 w-4 animate-spin" />
                Updating...
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
