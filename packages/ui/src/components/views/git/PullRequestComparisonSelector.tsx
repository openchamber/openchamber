import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { useTabletLayout } from '@/lib/device';
import { cn } from '@/lib/utils';
import type { usePullRequestComparison } from '@/hooks/usePullRequestComparison';

export function PullRequestComparisonSelector({ comparison, mobile = false }: {
  comparison: ReturnType<typeof usePullRequestComparison>;
  mobile?: boolean;
}) {
  const { t } = useI18n();
  const tablet = useTabletLayout();
  const sheet = mobile && !tablet.enabled;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!comparison.enabled) setOpen(false); }, [comparison.enabled]);
  const label = t('pullRequestComparison.select');
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next && !comparison.loading) void comparison.refresh();
    if (!next) comparison.setQuery('');
  };
  const selected = comparison.selectedSource;
  const trigger = <Button variant="outline" className={cn(dropdownTriggerVariants({ size: mobile ? 'default' : 'sm' }), 'min-w-0 max-w-48')}
    data-mobile-comparison-trigger={mobile || undefined}
    onClick={sheet ? () => changeOpen(true) : undefined}
    aria-haspopup={sheet ? 'dialog' : undefined} aria-expanded={sheet ? open : undefined}
    aria-label={label} title={selected?.sourceRepo ? `${selected.sourceRepo.owner}/${selected.sourceRepo.repo} #${selected.number}` : label}>
    <span className="truncate">{selected ? `#${selected.number}` : label}</span>
    <Icon name="arrow-down-s" className="size-3.5" />
  </Button>;
  const picker = <Command shouldFilter={false} onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <CommandInput autoFocus={!sheet} value={comparison.query} onValueChange={comparison.setQuery}
      placeholder={t('session.githubPrPicker.searchPlaceholder')} aria-label={t('session.githubPrPicker.searchPlaceholder')} />
    {comparison.loading ? <div className="flex items-center gap-2 p-4 typography-meta text-muted-foreground">
      <Icon name="loader-4" className="size-4 animate-spin" />{t('session.githubPrPicker.loading.pullRequests')}
    </div> : comparison.error && comparison.prs.length === 0 ? <div className="flex flex-col items-center gap-2 p-4 typography-meta text-muted-foreground">
      <span>{comparison.error}</span>
      <Button variant="outline" size="sm" onClick={() => void comparison.refresh()}>{t('diffView.actions.retry')}</Button>
    </div> : <CommandList className={mobile ? 'max-h-[min(45dvh,24rem)]' : undefined}>
      <CommandEmpty>{t('session.githubPrPicker.empty.noPullRequestsFound')}</CommandEmpty>
      <CommandGroup>
        {open && comparison.prs.map((pr) => {
          const key = `${pr.sourceRepo?.owner}/${pr.sourceRepo?.repo}#${pr.number}`;
          return <CommandItem key={key} value={key} className={mobile ? 'min-h-11' : undefined}
            onSelect={() => { comparison.select(pr); changeOpen(false); }}>
            <div className="min-w-0 flex-1">
              <div className="truncate typography-ui-label" title={pr.title}>#{pr.number} {pr.title}</div>
              <div className="truncate typography-meta text-muted-foreground">{pr.sourceRepo?.owner}/{pr.sourceRepo?.repo} · {pr.head} → {pr.base}</div>
            </div>
            {selected?.number === pr.number && selected.sourceRepo?.owner === pr.sourceRepo?.owner && selected.sourceRepo?.repo === pr.sourceRepo?.repo
              && <Icon name="check" className="size-3.5" />}
          </CommandItem>;
        })}
      </CommandGroup>
      {comparison.error && <p className="px-3 py-2 typography-meta text-muted-foreground">{comparison.error}</p>}
      {comparison.hasMore && <Button variant="ghost" size="sm" disabled={comparison.loadingMore} onClick={() => void comparison.loadMore()}>
        {comparison.error ? t('diffView.actions.retry') : t('session.githubPrPicker.actions.loadMore')}
      </Button>}
    </CommandList>}
  </Command>;
  if (sheet) return <>{trigger}<MobileOverlayPanel open={open} title={label} onClose={() => changeOpen(false)}>{picker}</MobileOverlayPanel></>;
  return <DropdownMenu open={open} onOpenChange={changeOpen}>
    <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-[32rem] max-w-[calc(100vw-2rem)] p-0">{picker}</DropdownMenuContent>
  </DropdownMenu>;
}
