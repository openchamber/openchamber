import * as React from 'react';
import { Popover } from '@base-ui/react/popover';

import { Icon } from '@/components/icon/Icon';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch } from '@/components/ui/MobileSheetList';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';

export type BoardChoice = {
    id: string;
    label: string;
    content: React.ReactNode;
};

type Choices =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; items: BoardChoice[] };

const sameSet = (left: readonly string[], right: ReadonlySet<string>) => (
    left.length === right.size && left.every((id) => right.has(id))
);

export const SourceBoardChoicePicker: React.FC<{
    ariaLabel: string;
    searchPlaceholder: string;
    emptyText: string;
    selected: readonly string[];
    selectedChoices: readonly BoardChoice[];
    loadChoices: () => Promise<BoardChoice[]>;
    onCommit: (ids: string[]) => void;
    busy: boolean;
    sheet?: boolean;
}> = ({ ariaLabel, searchPlaceholder, emptyText, selected, selectedChoices, loadChoices, onCommit, busy, sheet = false }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [choices, setChoices] = React.useState<Choices>({ status: 'loading' });
    const [picked, setPicked] = React.useState<Set<string>>(() => new Set(selected));
    const openedWith = React.useRef<readonly string[]>(selected);
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);

    const items = React.useMemo(() => {
        if (choices.status !== 'ready') return [];
        const listed = new Set(choices.items.map((choice) => choice.id));
        const all = [...selectedChoices.filter((choice) => !listed.has(choice.id)), ...choices.items];
        return query ? rankByQuery(all, query, (choice) => [choice.label]) : all;
    }, [choices, query, selectedChoices]);
    const effectiveActive = activeId && items.some((choice) => choice.id === activeId) ? activeId : items[0]?.id ?? null;

    const openChange = (next: boolean) => {
        setOpen(next);
        setQuery('');
        setActiveId(null);
        if (next) {
            openedWith.current = selected;
            setPicked(new Set(selected));
            setChoices({ status: 'loading' });
            void loadChoices().then(
                (loaded) => setChoices({ status: 'ready', items: loaded }),
                (error: Error) => setChoices({ status: 'error', message: error.message }),
            );
            return;
        }
        const result = new Set(selected);
        for (const id of picked) if (!openedWith.current.includes(id)) result.add(id);
        for (const id of openedWith.current) if (!picked.has(id)) result.delete(id);
        if (!sameSet(selected, result)) onCommit([...result].sort());
    };

    const toggle = (id: string) => setPicked((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    const status = choices.status === 'loading' ? (
        <div role="status" className="flex justify-center px-3 py-6">
            <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
        </div>
    ) : choices.status === 'error' ? (
        <div role="alert" className="px-3 py-4 typography-meta text-muted-foreground">
            <p>{t('sourceBoard.choices.loadFailed')}</p>
            <p className="mt-1 break-words">{choices.message}</p>
        </div>
    ) : items.length === 0 ? (
        <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">{emptyText}</div>
    ) : null;
    const triggerIcon = <Icon name={busy ? 'loader-4' : 'pencil'} className={cn('size-3.5', busy && 'animate-spin')} />;

    if (sheet) {
        return (
            <>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label={ariaLabel}
                    aria-haspopup="dialog"
                    disabled={busy}
                    onClick={() => openChange(true)}
                    className="size-9 shrink-0 px-0 text-muted-foreground"
                >
                    {triggerIcon}
                </Button>
                <MobileOverlayPanel
                    open={open}
                    title={ariaLabel}
                    onClose={() => openChange(false)}
                    subheader={<MobileSheetSearch value={query} onChange={setQuery} placeholder={searchPlaceholder} />}
                >
                    {status ?? items.map((choice) => (
                        <MobileSheetRow key={choice.id} selected={picked.has(choice.id)} onClick={() => toggle(choice.id)}>
                            {choice.content}
                        </MobileSheetRow>
                    ))}
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <Popover.Root open={open} onOpenChange={openChange} onOpenChangeComplete={(next) => { if (next) searchRef.current?.focus(); }}>
            <ButtonTooltip label={ariaLabel} className="shrink-0">
                <Popover.Trigger
                    render={
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label={ariaLabel}
                            aria-haspopup="dialog"
                            disabled={busy}
                            className="size-6 shrink-0 px-0 text-muted-foreground data-[popup-open]:bg-interactive-hover"
                        />
                    }
                >
                    {triggerIcon}
                </Popover.Trigger>
            </ButtonTooltip>
            <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
                    <Popover.Popup
                        role="dialog"
                        aria-label={ariaLabel}
                        className={cn(dropdownMenuPopupClass, 'flex max-h-80 w-72 max-w-[calc(100vw-2rem)] flex-col p-0')}
                        initialFocus={false}
                    >
                        <Command className="min-h-0 flex-1" shouldFilter={false} value={effectiveActive ?? undefined} onValueChange={setActiveId}>
                            <CommandInput
                                ref={searchRef}
                                aria-label={searchPlaceholder}
                                placeholder={searchPlaceholder}
                                value={query}
                                onValueChange={setQuery}
                                onKeyDown={(event) => {
                                    if (isIMECompositionEvent(event)) {
                                        event.stopPropagation();
                                        return;
                                    }
                                    handleDropdownNavigationKey(event, (navigationKey) => {
                                        event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key: navigationKey, bubbles: true, cancelable: true }));
                                    });
                                }}
                            />
                            <CommandList label={ariaLabel}>
                                {status ?? items.map((choice) => {
                                    const checked = picked.has(choice.id);
                                    return (
                                        <CommandItem
                                            key={choice.id}
                                            value={choice.id}
                                            onSelect={() => toggle(choice.id)}
                                            aria-current={checked ? true : undefined}
                                            className="max-w-full"
                                        >
                                            <span className="flex size-4 shrink-0 items-center justify-center">
                                                {checked ? <Icon name="check" className="size-4 text-foreground" /> : null}
                                            </span>
                                            <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{choice.content}</span>
                                        </CommandItem>
                                    );
                                })}
                            </CommandList>
                        </Command>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
};
