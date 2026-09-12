import { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { useTabletLayout } from '@/lib/device';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { branchRefLabel } from './baseBranch';

interface BranchComparisonSelectorProps {
  branches: readonly string[];
  currentBranch: string | null;
  base: string | null;
  onSelect: (ref: string) => void;
  mobile?: boolean;
}

export function BranchComparisonSelector({ branches, currentBranch, base, onSelect, mobile = false }: BranchComparisonSelectorProps) {
  const { t } = useI18n();
  const tabletLayout = useTabletLayout();
  const useSheet = mobile && !tabletLayout.enabled;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const label = base ? branchRefLabel(base) : t('gitView.pr.field.baseBranch');

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setSearch('');
  };
  const trigger = (
    <Button
      variant="outline"
      className={cn(dropdownTriggerVariants({ size: mobile ? 'default' : 'sm' }), 'min-w-0 max-w-48')}
      data-mobile-comparison-trigger={mobile || undefined}
      aria-label={t('gitView.pr.field.baseBranch')}
      aria-haspopup={useSheet ? 'dialog' : undefined}
      aria-expanded={useSheet ? open : undefined}
      title={label}
      disabled={!currentBranch}
      onClick={useSheet ? () => changeOpen(true) : undefined}
    >
      <Icon name="git-branch" className="size-3.5" />
      <span className="truncate">{label}</span>
      <Icon name="arrow-down-s" className="size-3.5" />
    </Button>
  );
  const picker = (
    <Command shouldFilter={false} className={mobile ? '[&_[data-slot=command-input-wrapper]]:h-11' : undefined} onKeyDown={(event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    }}>
      <CommandInput
        autoFocus={!useSheet}
        className={mobile ? 'h-11' : undefined}
        value={search}
        onValueChange={setSearch}
        placeholder={t('gitView.branch.searchPlaceholder')}
        aria-label={t('gitView.branch.searchPlaceholder')}
      />
      <CommandList className={mobile ? 'max-h-[min(45dvh,24rem)]' : undefined}>
        <CommandEmpty>{t('gitView.branch.empty')}</CommandEmpty>
        <CommandGroup>
          {open && rankByQuery(
            [...new Set(branches)]
              .filter((name) => name !== currentBranch)
              .sort()
              .map((name) => ({
                ref: name.startsWith('remotes/') ? `refs/${name}` : `refs/heads/${name}`,
                label: branchRefLabel(name),
              })),
            search,
            (branch) => [branch.label],
          ).map((branch) => (
            <CommandItem key={branch.ref} value={branch.ref} className={mobile ? 'min-h-11' : undefined} onSelect={() => {
              onSelect(branch.ref);
              changeOpen(false);
            }}>
              <span className="min-w-0 flex-1 truncate" title={branch.ref}>{branch.label}</span>
              {(branch.ref === base || branch.label === base) && <Icon name="check" className="size-3.5" />}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
  if (useSheet) {
    return <>
      {trigger}
      <MobileOverlayPanel open={open} title={t('gitView.pr.field.baseBranch')} onClose={() => changeOpen(false)}>
        {picker}
      </MobileOverlayPanel>
    </>;
  }
  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)] p-0">
        {picker}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
