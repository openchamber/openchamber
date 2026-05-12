import React from 'react';
import { RiArchiveStackLine, RiDeleteBinLine, RiInboxArchiveLine, RiInboxUnarchiveFill, RiInboxUnarchiveLine, RiLoader4Line, RiSearchLine } from '@remixicon/react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitStashEntry } from '@/lib/api/types';
import { applyGitStash, countGitStashFiles, dropGitStash, listGitStashes, popGitStash, stashGitChanges } from '@/lib/gitApi';

interface StashesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string | null;
  hasUncommittedChanges: boolean;
  uncommittedFileCount: number;
  onChanged?: () => void | Promise<void>;
}

type StashOperation = 'create' | `apply:${string}` | `pop:${string}` | `drop:${string}` | null;

export const StashesDialog: React.FC<StashesDialogProps> = ({
  open,
  onOpenChange,
  directory,
  hasUncommittedChanges,
  uncommittedFileCount,
  onChanged,
}) => {
  const { t } = useI18n();
  const [stashes, setStashes] = React.useState<GitStashEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [operation, setOperation] = React.useState<StashOperation>(null);
  const [fileCounts, setFileCounts] = React.useState<Record<string, number>>({});

  const load = React.useCallback(async () => {
    if (!directory) return;
    setIsLoading(true);
    try {
      const result = await listGitStashes(directory);
      setStashes(result.stashes);
      setFileCounts({});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.stashes.toast.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [directory, t]);

  React.useEffect(() => {
    if (open) void load();
  }, [load, open]);

  React.useEffect(() => {
    if (!open || !directory || stashes.length === 0) return;
    let cancelled = false;
    const refs = stashes.map((stash) => stash.ref);
    void countGitStashFiles(directory, refs).then((result) => {
      if (!cancelled) setFileCounts(result.counts);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [directory, open, stashes]);

  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return stashes;
    return stashes.filter((stash) => `${stash.ref} ${stash.message} ${stash.relativeTime}`.toLowerCase().includes(normalized));
  }, [query, stashes]);

  const refreshAfterChange = React.useCallback(async () => {
    await load();
    await onChanged?.();
  }, [load, onChanged]);

  const handleCreate = async () => {
    if (!directory || operation) return;
    setOperation('create');
    try {
      const result = await stashGitChanges(directory, { message: message.trim() || undefined });
      if (result.created) {
        toast.success(t('gitView.stashes.toast.created'));
        setMessage('');
      } else {
        toast.info(t('gitView.stashes.toast.noChanges'));
      }
      await refreshAfterChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('gitView.stashes.toast.createFailed'));
    } finally {
      setOperation(null);
    }
  };

  const runStashAction = async (stash: GitStashEntry, kind: 'apply' | 'pop' | 'drop') => {
    if (!directory || operation) return;
    if (kind === 'drop' && !window.confirm(t('gitView.stashes.confirm.drop', { ref: stash.ref }))) return;
    setOperation(`${kind}:${stash.ref}`);
    try {
      if (kind === 'apply') await applyGitStash(directory, { ref: stash.ref });
      if (kind === 'pop') await popGitStash(directory, { ref: stash.ref });
      if (kind === 'drop') await dropGitStash(directory, { ref: stash.ref });
      const successKey = kind === 'apply' ? 'gitView.stashes.toast.applySuccess' : kind === 'pop' ? 'gitView.stashes.toast.popSuccess' : 'gitView.stashes.toast.dropSuccess';
      toast.success(t(successKey));
      await refreshAfterChange();
    } catch (error) {
      const failedKey = kind === 'apply' ? 'gitView.stashes.toast.applyFailed' : kind === 'pop' ? 'gitView.stashes.toast.popFailed' : 'gitView.stashes.toast.dropFailed';
      toast.error(error instanceof Error ? error.message : t(failedKey));
      await refreshAfterChange();
    } finally {
      setOperation(null);
    }
  };

  const isOperating = operation !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RiArchiveStackLine className="h-5 w-5" />
            {t('gitView.stashes.title')}
          </DialogTitle>
          <DialogDescription>{t('gitView.stashes.description')}</DialogDescription>
        </DialogHeader>

        <div className="mt-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t('gitView.stashes.messagePlaceholder')}
              disabled={isOperating || !hasUncommittedChanges}
              className="flex-1"
            />
            <Button onClick={handleCreate} disabled={!hasUncommittedChanges || isOperating || !directory}>
              {operation === 'create' ? <RiLoader4Line className="size-4 animate-spin" /> : <RiInboxArchiveLine className="size-4" />}
              {t('gitView.stashes.actions.stashCurrentWithCount', { count: uncommittedFileCount })}
            </Button>
          </div>
          <p className="typography-meta mt-2 text-muted-foreground">{t('gitView.stashes.includeUntrackedHint')}</p>
        </div>

        <div className="relative mt-2">
          <RiSearchLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('gitView.stashes.searchPlaceholder')} className="pl-9" />
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground"><RiLoader4Line className="size-5 animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">{query ? t('gitView.stashes.empty.search') : t('gitView.stashes.empty.list')}</div>
          ) : filtered.map((stash, index) => (
            <div key={stash.ref} className="group flex items-center gap-2 rounded py-1.5 transition-colors hover:bg-interactive-hover/30">
              <div className="min-w-0 flex-1 pl-2">
                <p className="typography-small truncate text-foreground">{stash.message || t('gitView.stashes.untitled')}</p>
                <p className="typography-meta truncate text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>{index === 0 && !query.trim() ? t('gitView.stashes.latestLabel') : t('gitView.stashes.itemNumber', { number: index + 1 })}</span>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{stash.ref}</TooltipContent>
                  </Tooltip>
                  {' · '}{stash.relativeTime} · {typeof fileCounts[stash.ref] === 'number' ? t('gitView.stashes.fileCount', { count: fileCounts[stash.ref] }) : t('gitView.stashes.fileCountLoading')}
                </p>
              </div>
              <div className="mr-2 flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                <StashIconButton label={t('gitView.stashes.actions.apply')} loading={operation === `apply:${stash.ref}`} onClick={() => runStashAction(stash, 'apply')} disabled={isOperating}><RiInboxUnarchiveLine className="size-4" /></StashIconButton>
                <StashIconButton label={t('gitView.stashes.actions.pop')} loading={operation === `pop:${stash.ref}`} onClick={() => runStashAction(stash, 'pop')} disabled={isOperating}><RiInboxUnarchiveFill className="size-4" /></StashIconButton>
                <StashIconButton label={t('gitView.stashes.actions.drop')} loading={operation === `drop:${stash.ref}`} onClick={() => runStashAction(stash, 'drop')} disabled={isOperating} destructive><RiDeleteBinLine className="size-4" /></StashIconButton>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const StashIconButton: React.FC<{ label: string; loading: boolean; disabled: boolean; destructive?: boolean; onClick: () => void; children: React.ReactNode }> = ({ label, loading, disabled, destructive, onClick, children }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={label} aria-busy={loading || undefined} className={cn('flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-50', destructive ? 'text-[var(--status-error)] hover:text-[var(--status-error)]' : 'text-muted-foreground hover:text-foreground')} onClick={onClick} disabled={disabled}>
        {loading ? <RiLoader4Line className="size-4 animate-spin" /> : children}
      </button>
    </TooltipTrigger>
    <TooltipContent sideOffset={6}>{label}</TooltipContent>
  </Tooltip>
);
