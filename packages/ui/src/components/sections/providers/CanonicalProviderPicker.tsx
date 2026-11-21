import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch } from '@/components/ui/MobileSheetList';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { ConnectableProvider } from './connectableProviders';

const RENDER_STEP = 200;
const NONE_VALUE = '';
const NONE_ITEM = '__none__';

export function CanonicalProviderPicker({
  value,
  providers,
  loading,
  disabled,
  onSelect,
}: {
  value: string;
  providers: readonly ConnectableProvider[];
  loading: boolean;
  disabled: boolean;
  onSelect: (providerID: string) => void;
}) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [renderLimit, setRenderLimit] = React.useState(RENDER_STEP);
  const label = t('settings.providers.page.custom.field.canonical.label');
  const noneLabel = t('settings.providers.page.custom.field.canonical.none');

  const needle = query.trim().toLocaleLowerCase();
  const matching = React.useMemo(() => (needle
    ? providers.filter((provider) => provider.name.toLocaleLowerCase().includes(needle) || provider.id.toLocaleLowerCase().includes(needle))
    : providers), [providers, needle]);
  const rows = needle ? matching : [{ id: NONE_VALUE, name: noneLabel }, ...matching];
  const visibleRows = rows.slice(0, renderLimit);
  const hasMore = renderLimit < rows.length;

  const observeListEnd = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setRenderLimit((limit) => limit + RENDER_STEP);
    }, { root: node.closest<HTMLElement>('[data-slot="command-list"]'), rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) { setQuery(''); setRenderLimit(RENDER_STEP); }
  };
  const choose = (providerID: string) => {
    onSelect(providerID);
    changeOpen(false);
  };
  const changeQuery = (next: string) => { setRenderLimit(RENDER_STEP); setQuery(next); };

  const status = rows.length === 0
    ? (loading ? t('settings.providers.page.custom.field.canonical.loading') : t('settings.providers.page.custom.field.canonical.noMatch'))
    : null;
  const listEndMarker = open && hasMore && !status ? <div ref={observeListEnd} aria-hidden="true" className="h-px" /> : null;
  const selectedName = value ? (providers.find((provider) => provider.id === value)?.name ?? value) : noneLabel;
  const triggerLabel = <span className={cn('truncate', value ? 'text-foreground' : 'text-muted-foreground')}>{selectedName}</span>;
  const searchPlaceholder = t('settings.providers.page.custom.field.canonical.search');

  if (isMobile) {
    return (
      <>
        <Button variant="outline" size="sm" aria-label={label} onClick={() => changeOpen(true)} disabled={disabled} className="h-9 w-full justify-between">
          {triggerLabel}
          <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground" />
        </Button>
        <MobileOverlayPanel
          open={open}
          title={label}
          onClose={() => changeOpen(false)}
          subheader={<MobileSheetSearch value={query} onChange={changeQuery} placeholder={searchPlaceholder} />}
        >
          {status ? (
            <div className="px-2 py-8 text-center typography-meta text-muted-foreground">{status}</div>
          ) : visibleRows.map((provider) => (
            <MobileSheetRow key={provider.id || NONE_ITEM} selected={value === provider.id} onClick={() => choose(provider.id)}>
              {provider.name}
            </MobileSheetRow>
          ))}
          {listEndMarker}
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-full max-w-full disabled:cursor-not-allowed disabled:opacity-50')}
        >
          {triggerLabel}
          <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        portalToBody
        className="flex max-h-[min(var(--available-height),24rem)] w-[var(--anchor-width)] min-w-[16rem] flex-col overflow-hidden p-0"
      >
        <Command shouldFilter={false} onKeyDown={(event) => { if (!shouldDismissDropdown(event)) event.stopPropagation(); }}>
          <CommandInput autoFocus placeholder={searchPlaceholder} value={query} onValueChange={changeQuery} />
          <CommandList disableHorizontal>
            {status ? <CommandEmpty>{status}</CommandEmpty> : visibleRows.map((provider) => (
              <CommandItem key={provider.id || NONE_ITEM} value={provider.id || NONE_ITEM} onSelect={() => choose(provider.id)}>
                <span className="typography-small truncate">{provider.name}</span>
              </CommandItem>
            ))}
            {listEndMarker}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
