import React from 'react';
import { RiLoader4Line, RiFileCopyLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { GitLogEntry, CommitFileEntry } from '@/lib/api/types';

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

export const HistoryCommitRow: React.FC<HistoryCommitRowProps> = ({
  entry,
  isExpanded,
  onToggle,
  files,
  isLoadingFiles,
  onCopyHash,
}) => {
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
            <Tooltip delayDuration={500}>
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
                  <RiFileCopyLine className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>Copy SHA</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2 pl-8 border-t border-border/40">
          {isLoadingFiles ? (
            <div className="flex items-center gap-2 py-2">
              <RiLoader4Line className="size-4 animate-spin text-muted-foreground" />
              <span className="typography-micro text-muted-foreground">Loading files...</span>
            </div>
          ) : files.length === 0 ? (
            <p className="typography-micro text-muted-foreground py-2">No files</p>
          ) : (
            <ul className="space-y-0.5 py-2">
              {files.map((file) => (
                <li
                  key={file.path}
                  className="flex items-center gap-2 typography-micro"
                >
                  <span
                    className={cn(
                      'font-semibold w-3 text-center',
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
                      binary
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
};
