import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { getCommitFileDiff, type CommitFileDiffResponse } from '@/lib/gitApi';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { opencodeClient } from '@/lib/opencode/client';

interface HistoryCommitRowProps {
  entry: GitLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
  files: CommitFileEntry[];
  isLoadingFiles: boolean;
  onCopyHash: (hash: string) => void;
}

function formatCommitDate(date: string) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) {
    return date;
  }

  return value.toLocaleString(undefined, {
    hour12: false,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getChangeTypeColor(changeType: string) {
  switch (changeType) {
    case 'A':
      return 'text-[var(--status-success)]';
    case 'D':
      return 'text-[var(--status-error)]';
    case 'M':
      return 'text-[var(--status-warning)]';
    case 'R':
      return 'text-[var(--status-info)]';
    default:
      return 'text-muted-foreground';
  }
}

export const HistoryCommitRow = React.memo(({
  entry,
  isExpanded,
  onToggle,
  files,
  isLoadingFiles,
  onCopyHash,
}: HistoryCommitRowProps) => {
  const { t } = useI18n();

  const [openDiffPaths, setOpenDiffPaths] = React.useState<Set<string>>(new Set());
  const [diffCache, setDiffCache] = React.useState<Map<string, CommitFileDiffResponse | 'loading' | 'error'>>(new Map());

  const toggleFileDiff = React.useCallback(async (file: CommitFileEntry) => {
    const key = file.path;

    if (file.changeType === 'R' || file.isBinary) {
      setOpenDiffPaths(prev => {
        const next = new Set(prev);
        if (next.has(key)) { next.delete(key); } else { next.add(key); }
        return next;
      });
      return;
    }

    const cached = diffCache.get(key);
    const isOpen = openDiffPaths.has(key);

    if (isOpen && cached !== 'error') {
      // Close it
      setOpenDiffPaths(prev => { const next = new Set(prev); next.delete(key); return next; });
      return;
    }

    // Open it (or re-fetch on error)
    setOpenDiffPaths(prev => { const next = new Set(prev); next.add(key); return next; });

    if (cached && cached !== 'error') return; // Already loaded

    setDiffCache(prev => new Map(prev).set(key, 'loading'));
    try {
      const directory = opencodeClient.getDirectory() ?? '';
      const result = await getCommitFileDiff(directory, entry.hash, file.path, file.isBinary);
      setDiffCache(prev => new Map(prev).set(key, result));
    } catch {
      setDiffCache(prev => new Map(prev).set(key, 'error'));
    }
  }, [diffCache, openDiffPaths, entry.hash]);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
          isExpanded ? 'bg-sidebar/90' : 'hover:bg-sidebar/40'
        )}
      >
        <div
          className="h-2 w-2 translate-y-2 rounded-full shrink-0"
          style={{ backgroundColor: 'var(--status-success)' }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="typography-ui-label font-medium text-foreground line-clamp-1">
            {entry.message}
          </p>
          <div className="flex items-center gap-1 typography-meta text-muted-foreground">
            <div className="flex items-center gap-1 min-w-0 truncate">
              <span className="truncate min-w-[3ch]" title={entry.author_name}>
                {entry.author_name}
              </span>
              <span className="shrink-0">·</span>
              <span className="truncate min-w-0" title={formatCommitDate(entry.date)}>
                {formatCommitDate(entry.date)}
              </span>
            </div>
            <span className="shrink-0">·</span>
            <code className="shrink-0 font-mono">
              {entry.hash.slice(0, 8)}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyHash(entry.hash);
                  }}
                >
                  <Icon name="file-copy" className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>{t('gitView.history.copySha')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 pl-8 border-t border-border/40">
          {isLoadingFiles ? (
            <div className="flex items-center gap-2 py-2">
              <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
              <span className="typography-micro text-muted-foreground">{t('gitView.history.loadingFiles')}</span>
            </div>
          ) : files.length === 0 ? (
            <p className="typography-micro text-muted-foreground py-2">{t('gitView.history.noFiles')}</p>
          ) : (
            <ul className="space-y-0.5 py-2">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => toggleFileDiff(file)}
                    className="w-full flex items-center gap-2 typography-micro text-left cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors rounded px-1"
                  >
                    <span
                      className={cn(
                        'font-semibold w-3 text-center shrink-0',
                        getChangeTypeColor(file.changeType)
                      )}
                    >
                      {file.changeType}
                    </span>
                    <span className="truncate text-foreground min-w-0" title={file.path}>
                      {file.path}
                    </span>
                    {!file.isBinary && (
                      <span className="shrink-0">
                        <span style={{ color: 'var(--status-success)' }}>
                          +{file.insertions}
                        </span>
                        <span className="text-muted-foreground mx-0.5">/</span>
                        <span style={{ color: 'var(--status-error)' }}>
                          -{file.deletions}
                        </span>
                      </span>
                    )}
                    {file.isBinary && (
                      <span className="typography-micro text-muted-foreground shrink-0">
                        {t('gitView.history.binary')}
                      </span>
                    )}
                    <Icon
                      name={openDiffPaths.has(file.path) ? 'arrow-down-s' : 'arrow-right-s'}
                      className="size-3 shrink-0 ml-auto text-muted-foreground"
                    />
                  </button>

                  {openDiffPaths.has(file.path) && (
                    <div className="max-h-[400px] overflow-y-auto rounded border border-border/40 mx-2 mb-1">
                      {file.changeType === 'R' ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.renamedNoDiff')}</div>
                      ) : file.isBinary ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.binaryNoDiff')}</div>
                      ) : (() => {
                        const cached = diffCache.get(file.path);
                        if (cached === 'loading' || cached === undefined) {
                          return <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.loadingDiff')}</div>;
                        }
                        if (cached === 'error') {
                          return <div className="px-3 py-2 text-sm text-muted-foreground">{t('gitView.history.diffError')}</div>;
                        }
                        return (
                          <PierreDiffViewer
                            original={cached.original}
                            modified={cached.modified}
                            language=""
                            fileName={file.path}
                            renderSideBySide={false}
                            layout="inline"
                          />
                        );
                      })()}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
});
