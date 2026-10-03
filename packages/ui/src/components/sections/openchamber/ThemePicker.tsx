import React from 'react';
import { toast } from 'sonner';
import { Popover } from '@base-ui/react/popover';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { shortcutRegistry } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { SETTINGS_CUSTOM_TRIGGER_CLASS } from '../shared/SettingsSection';

export interface ThemePickerOption {
  id: string;
  label: string;
}

interface ThemePickerProps {
  options: readonly ThemePickerOption[];
  value: string;
  onValueChange: (id: string) => void;
  placeholder: string;
  /** Accessible name of the trigger and the popup. */
  ariaLabel: string;
}

/**
 * Searchable theme picker for the Appearance page. A plain Select becomes
 * unusable once the list holds dozens of built-in and imported themes, so the
 * popup owns a search field and a ranked list; imported themes keep their
 * inline delete action. Mobile gets the same list in a bottom sheet with
 * the search field left unfocused, so opening the picker never pops the
 * keyboard.
 */
/**
 * Put the row for `id` in the middle of its cmdk scroller. Rectangles are
 * divided by the popup's entrance scale so this works while the popup is still
 * animating in; scrollTop itself is in unscaled layout pixels.
 */
const centerRow = (command: Element | null | undefined, id: string, options?: { onlyIfHidden?: boolean }) => {
  const list = command?.querySelector<HTMLElement>('[cmdk-list]');
  // Match by value rather than data-selected: cmdk applies the selection
  // attribute in a follow-up render, after the row has mounted.
  const row = command?.querySelector<HTMLElement>(`[cmdk-item][data-value="${CSS.escape(id)}"]`);
  if (!list || !row) return;
  const listRect = list.getBoundingClientRect();
  const scale = list.offsetHeight > 0 ? listRect.height / list.offsetHeight : 1;
  if (scale <= 0) return;
  const rowRect = row.getBoundingClientRect();
  const rowTop = (rowRect.top - listRect.top) / scale + list.scrollTop;
  const rowHeight = rowRect.height / scale;
  if (options?.onlyIfHidden) {
    const visible = rowTop >= list.scrollTop && rowTop + rowHeight <= list.scrollTop + list.clientHeight;
    if (visible) return;
  }
  list.scrollTop = Math.max(0, rowTop - (list.clientHeight - rowHeight) / 2);
};

export function ThemePicker({ options, value, onValueChange, placeholder, ariaLabel }: ThemePickerProps) {
  const { t } = useI18n();
  const { deleteImportedTheme, customThemeIds } = useThemeSystem();
  const { isMobile } = useDeviceInfo();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeId, setActiveId] = React.useState<string | undefined>(undefined);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // Same containment as Select: portal into the enclosing dialog, keep the
  // popup inside main.
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const [collisionBoundary, setCollisionBoundary] = React.useState<Element | null>(null);
  const syncContainers = React.useCallback((target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    const dialog = element?.closest('[data-slot="dialog-content"], [role="dialog"]');
    setPortalContainer(dialog instanceof HTMLElement ? dialog : null);
    setCollisionBoundary(element?.closest('main') ?? null);
  }, []);

  // Typing in the search must not fire global shortcuts.
  React.useEffect(() => {
    if (!open) return;
    return shortcutRegistry.suspend();
  }, [open]);

  // Center the current theme before the first paint so the list opens in
  // place instead of visibly scrolling there. This has to be a callback ref,
  // not an effect on `open`: Base UI's portal renders its content one render
  // after the portal node exists, so an `open` effect fires before the list
  // is in the DOM. The ref attaches in the commit that mounts the list, after
  // the rows' own layout effects have written `data-value`. cmdk's deferred
  // scroll-to-active is a no-op afterwards because the row is fully visible.
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const commandRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node) centerRow(node, valueRef.current);
  }, []);

  const selected = options.find((option) => option.id === value);
  const filtered = React.useMemo(
    () => (open ? rankByQuery(options, query, (option) => [option.label]) : options),
    [open, options, query],
  );

  const select = (id: string) => {
    onValueChange(id);
    setOpen(false);
  };

  const remove = async (option: ThemePickerOption) => {
    if (deletingId) return;
    setDeletingId(option.id);
    try {
      await deleteImportedTheme(option.id);
      // The row is gone; keep the keyboard in the search field.
      searchRef.current?.focus();
    } catch {
      toast.error(t('settings.themeImport.deleteError'));
    } finally {
      setDeletingId(null);
    }
  };

  const renderDeleteButton = (option: ThemePickerOption) => {
    if (!customThemeIds.includes(option.id)) return null;
    const isDeleting = deletingId === option.id;
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        disabled={isDeleting}
        aria-label={t('settings.themeImport.delete', { name: option.label })}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void remove(option);
        }}
      >
        <Icon name={isDeleting ? 'loader' : 'delete-bin'} className={isDeleting ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
    );
  };

  const emptyState = (
    <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">
      {t('settings.openchamber.visual.field.noThemesFound')}
    </div>
  );

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, !selected && 'text-muted-foreground')}
          onClick={() => {
            setQuery('');
            setOpen(true);
          }}
        >
          <span className="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
          <Icon name="arrow-down-s" className="size-4 opacity-50" />
        </button>
        <MobileOverlayPanel open={open} title={ariaLabel} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('settings.openchamber.visual.field.searchThemes')}
              aria-label={t('settings.openchamber.visual.field.searchThemes')}
              className="h-9"
            />
            <div className="flex flex-col" role="listbox" aria-label={ariaLabel}>
              {filtered.length === 0 ? emptyState : filtered.map((option) => (
                <div key={option.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                    onClick={() => select(option.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.id === value ? (
                      <Icon name="check" className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </button>
                  {renderDeleteButton(option)}
                </div>
              ))}
            </div>
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setQuery('');
        // Enter without typing repeats the current choice.
        setActiveId(nextOpen ? value : undefined);
        setOpen(nextOpen);
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          triggerRef.current?.focus();
          return;
        }
        searchRef.current?.focus();
        // Fallback only: if positioning shrank the list enough to push the
        // row out of view, bring it back. Otherwise nothing moves.
        centerRow(searchRef.current?.closest('[data-slot="command"]'), value, { onlyIfHidden: true });
      }}
    >
      <Popover.Trigger
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, !selected && 'text-muted-foreground')}
        onPointerDownCapture={(event) => syncContainers(event.currentTarget)}
        onFocusCapture={(event) => syncContainers(event.currentTarget)}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
        <Icon name="arrow-down-s" className="size-4 opacity-50" />
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        {/* Anchored below the trigger with side flips disabled so the search
            field stays put while the result list changes height. */}
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          collisionAvoidance={{ side: 'none' }}
          collisionBoundary={collisionBoundary ?? undefined}
          className="z-[120]"
        >
          <Popover.Popup
            role="dialog"
            aria-label={ariaLabel}
            className={cn(dropdownMenuPopupClass, 'flex w-[var(--anchor-width)] min-w-[16rem] max-w-[calc(100vw-2rem)] flex-col p-0')}
            initialFocus={false}
            finalFocus={false}
          >
            {/* rankByQuery owns filtering and order; cmdk must not re-filter. */}
            <Command ref={commandRef} className="min-h-0 flex-1" shouldFilter={false} value={activeId} onValueChange={setActiveId}>
              <CommandInput
                ref={searchRef}
                aria-label={t('settings.openchamber.visual.field.searchThemes')}
                placeholder={t('settings.openchamber.visual.field.searchThemes')}
                value={query}
                onValueChange={setQuery}
                onKeyDown={(event) => {
                  if (isIMECompositionEvent(event)) {
                    event.stopPropagation();
                    return;
                  }
                  handleDropdownNavigationKey(event, (navigationKey) => {
                    event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', {
                      key: navigationKey,
                      bubbles: true,
                      cancelable: true,
                    }));
                  });
                }}
              />
              {/* Fixed cap so the positioner's --available-height rarely
                  resizes the scroller after the first paint. */}
              <CommandList label={ariaLabel} className="max-h-[20rem] p-1">
                {filtered.length === 0 ? emptyState : filtered.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={select}
                    aria-current={option.id === value ? true : undefined}
                    className="max-w-full typography-ui-label"
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.id === value ? (
                      <Icon name="check" className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                    {renderDeleteButton(option)}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
