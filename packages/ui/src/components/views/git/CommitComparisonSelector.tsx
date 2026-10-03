import { useState } from 'react';
import type { GitLogEntry } from '@/lib/api/types';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { useTabletLayout } from '@/lib/device';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

interface CommitComparisonSelectorProps {
  commits: readonly GitLogEntry[];
  selectedHash: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (commit: GitLogEntry) => void;
  onRefresh: () => void;
  mobile?: boolean;
}

export function CommitComparisonSelector({ commits, selectedHash, loading, error, onSelect, onRefresh, mobile = false }: CommitComparisonSelectorProps) {
  const { t } = useI18n();
  const tabletLayout = useTabletLayout();
  const useSheet = mobile && !tabletLayout.enabled;
  const timeFormat = useUIStore((state) => state.timeFormatPreference);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) setSearch('');
    else if (!loading) onRefresh();
  };
  const trigger = (
    <Button variant="outline" className={cn(dropdownTriggerVariants({ size: mobile ? 'default' : 'sm' }), 'min-w-0 max-w-48')}
      data-mobile-comparison-trigger={mobile || undefined}
      onClick={useSheet ? () => changeOpen(true) : undefined}
      aria-haspopup={useSheet ? 'dialog' : undefined}
      aria-expanded={useSheet ? open : undefined}
      aria-label={t('commitComparison.select')} title={selectedHash ?? t('commitComparison.select')}>
      <Icon name="git-commit" className="size-3.5" />
      <span className="truncate">{selectedHash?.slice(0, 8) ?? t('commitComparison.select')}</span>
      <Icon name="arrow-down-s" className="size-3.5" />
    </Button>
  );
  const picker = (
    <Command shouldFilter={false} className={mobile ? '[&_[data-slot=command-input-wrapper]]:h-11' : undefined} onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <CommandInput autoFocus={!useSheet} className={mobile ? 'h-11' : undefined} value={search} onValueChange={setSearch} placeholder={t('commitComparison.search')} aria-label={t('commitComparison.search')} />
      {loading ? (
        <div className="flex items-center justify-center gap-2 p-4 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />{t('diffView.state.loadingChanges')}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 p-4 typography-meta text-muted-foreground">
          <span>{t('commitComparison.loadError')}</span>
          <span className="max-w-full break-words">{error}</span>
          <Button variant="outline" size={mobile ? 'lg' : 'sm'} onClick={onRefresh}>{t('diffView.actions.retry')}</Button>
        </div>
      ) : (
        <CommandList className={mobile ? 'max-h-[min(45dvh,24rem)]' : undefined}>
          <CommandEmpty>{t('commitComparison.noCommits')}</CommandEmpty>
          <CommandGroup>
            {open && rankByQuery(commits, search, (commit) => [commit.message, commit.author_name, commit.hash]).map((commit) => (
              <CommandItem key={commit.hash} value={commit.hash} className={mobile ? 'min-h-11' : undefined} onSelect={() => { onSelect(commit); changeOpen(false); }}>
                <div className="min-w-0 flex-1">
                  <div className="truncate typography-ui-label font-semibold" title={commit.message}>{commit.message}</div>
                  <div className="flex min-w-0 gap-1 typography-meta text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {commit.author_name} · {Number.isNaN(new Date(commit.date).getTime()) ? commit.date : formatDateTimeForPreference(new Date(commit.date), timeFormat, {
                        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    <span className="shrink-0">· {commit.hash.slice(0, 8)}</span>
                  </div>
                </div>
                {commit.hash === selectedHash && <Icon name="check" className="size-3.5" />}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      )}
    </Command>
  );
  if (useSheet) {
    return <>
      {trigger}
      <MobileOverlayPanel open={open} title={t('commitComparison.select')} onClose={() => changeOpen(false)}>
        {picker}
      </MobileOverlayPanel>
    </>;
  }
  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[32rem] max-w-[calc(100vw-2rem)] p-0">
        {picker}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
