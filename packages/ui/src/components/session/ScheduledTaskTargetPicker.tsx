import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { handleDropdownNavigationKey, shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch } from '@/components/ui/MobileSheetList';
import type { Session } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { scheduledTaskTargetResults, type ScheduledTaskTargetRow } from './scheduledTaskTargetResults';

type TargetResults = ReturnType<typeof scheduledTaskTargetResults>;
const NO_RESULTS: TargetResults = { selected: null, rows: [], more: false };

export function ScheduledTaskTargetPicker({ value, eligible, known, load, isMobile, onSelect }: {
  value: string;
  eligible: readonly Session[];
  known: readonly Session[];
  load: 'loading' | 'error' | 'ready';
  isMobile: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const rankById = useSessionOrderingStore((state) => state.rankById);

  const [closingResults, setClosingResults] = React.useState<TargetResults>(NO_RESULTS);
  const openResults = React.useMemo(() => (open ? scheduledTaskTargetResults({
    eligible,
    known,
    query,
    selectedId: value,
    compare: (left, right) => compareSessionsByLifecycleOrder(left, right, pinnedSessionIds, rankById),
  }) : null), [open, eligible, known, query, value, pinnedSessionIds, rankById]);
  const results = openResults ?? closingResults;
  const rows = results.selected ? [results.selected, ...results.rows] : results.rows;
  const status = load === 'loading'
    ? t('common.loading')
    : load === 'error'
      ? t('sessions.scheduledTasks.editor.targetLoadFailed')
      : rows.length > 0
        ? null
        : query.trim()
          ? t('sessions.scheduledTasks.editor.target.noMatch')
          : results.more ? null : t('sessions.scheduledTasks.editor.target.empty');
  const moreHint = load === 'ready' && results.more ? t('sessions.scheduledTasks.editor.target.keepTyping') : null;
  const selectedTitle = value ? known.find((session) => session.id === value)?.title.trim() || value : '';

  const changeOpen = (next: boolean) => {
    if (next) setQuery('');
    else setClosingResults(results);
    setOpen(next);
  };
  const choose = (sessionId: string) => {
    onSelect(sessionId);
    changeOpen(false);
  };
  const subagentLabel = (row: ScheduledTaskTargetRow) => (row.parentTitle
    ? t('sessions.scheduledTasks.editor.target.subagentOf', { parent: row.parentTitle })
    : t('sessions.scheduledTasks.editor.target.subagent'));
  const trigger = (
    <button
      type="button"
      {...(isMobile ? { onClick: () => changeOpen(true), 'aria-haspopup': 'dialog' as const, 'aria-expanded': open } : {})}
      className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-fit max-w-full')}>
      <span dir={value ? 'auto' : undefined} className={cn('truncate', value ? 'text-foreground' : 'text-muted-foreground')}>
        {selectedTitle || t('sessions.scheduledTasks.editor.targetSession')}
      </span>
      <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
  const searchPlaceholder = t('sessions.scheduledTasks.editor.target.search');
  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (shouldDismissDropdown(event)) return;
    if (isIMECompositionEvent(event)) {
      event.stopPropagation();
      return;
    }
    const target = event.currentTarget;
    const navigated = handleDropdownNavigationKey(event, (key) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    if (!navigated) event.stopPropagation();
  };

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileOverlayPanel
          open={open}
          title={t('sessions.scheduledTasks.editor.targetSession')}
          onClose={() => changeOpen(false)}
          subheader={<MobileSheetSearch value={query} onChange={setQuery} placeholder={searchPlaceholder} />}
        >
          {status ? (
            <div className="px-2 py-8 text-center typography-meta text-muted-foreground">{status}</div>
          ) : rows.map((row) => (
            <MobileSheetRow key={row.id} selected={row.id === value} onClick={() => choose(row.id)}>
              <span dir="auto" className="block truncate">{row.title}</span>
              {row.subagent ? <span className="block truncate typography-meta text-muted-foreground">{subagentLabel(row)}</span> : null}
            </MobileSheetRow>
          ))}
          {moreHint ? <div className="px-2 py-3 text-center typography-meta text-muted-foreground">{moreHint}</div> : null}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        portalToBody
        className="flex max-h-[min(var(--available-height),24rem)] w-[max(var(--anchor-width),22rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
      >
        <Command shouldFilter={false} onKeyDown={handleListKeyDown}>
          <CommandInput autoFocus placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList disableHorizontal>
            {status ? <CommandEmpty>{status}</CommandEmpty> : rows.map((row) => (
              <CommandItem key={row.id} value={row.id} onSelect={() => choose(row.id)} aria-current={row.id === value ? true : undefined}>
                <span className="flex min-w-0 flex-col">
                  <span dir="auto" className="truncate typography-small">{row.title}</span>
                  {row.subagent ? <span className="truncate typography-meta text-muted-foreground">{subagentLabel(row)}</span> : null}
                </span>
                {row.id === value ? <Icon name="check" className="ms-auto size-4 shrink-0" /> : null}
              </CommandItem>
            ))}
            {moreHint ? <div className="px-3 py-2 typography-meta text-muted-foreground">{moreHint}</div> : null}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
