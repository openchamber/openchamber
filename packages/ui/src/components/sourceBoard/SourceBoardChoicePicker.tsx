import * as React from 'react';
import { Popover } from '@base-ui/react/popover';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';

export type BoardChoice = {
    /** What the host names it by: a label's name, a reviewer's id. */
    id: string;
    /** What the search matches. */
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

/**
 * Several of a list, picked with checks in a searchable popup: an item's
 * labels or a PR's reviewers. The choices are read when it opens; the new set
 * is handed over once, when it closes, so a few clicks are one change.
 */
export const SourceBoardChoicePicker: React.FC<{
    ariaLabel: string;
    searchPlaceholder: string;
    emptyText: string;
    selected: readonly string[];
    /** What is chosen now but may be past the one page the host lists. */
    selectedChoices: readonly BoardChoice[];
    loadChoices: () => Promise<BoardChoice[]>;
    onCommit: (ids: string[]) => void;
    busy: boolean;
}> = ({ ariaLabel, searchPlaceholder, emptyText, selected, selectedChoices, loadChoices, onCommit, busy }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [choices, setChoices] = React.useState<Choices>({ status: 'loading' });
    const [picked, setPicked] = React.useState<Set<string>>(() => new Set(selected));
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
            setPicked(new Set(selected));
            setChoices({ status: 'loading' });
            void loadChoices().then(
                (loaded) => setChoices({ status: 'ready', items: loaded }),
                (error: Error) => setChoices({ status: 'error', message: error.message }),
            );
            return;
        }
        if (!sameSet(selected, picked)) onCommit([...picked].sort());
    };

    const toggle = (id: string) => setPicked((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    return (
        <Popover.Root open={open} onOpenChange={openChange} onOpenChangeComplete={(next) => { if (next) searchRef.current?.focus(); }}>
            <Popover.Trigger
                render={
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-label={ariaLabel}
                        title={ariaLabel}
                        aria-haspopup="dialog"
                        disabled={busy}
                        className="size-6 shrink-0 px-0 text-muted-foreground data-[popup-open]:bg-interactive-hover"
                    />
                }
            >
                <Icon name={busy ? 'loader-4' : 'pencil'} className={cn('size-3.5', busy && 'animate-spin')} />
            </Popover.Trigger>
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
                                {choices.status === 'loading' ? (
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
                                ) : items.map((choice) => {
                                    const checked = picked.has(choice.id);
                                    return (
                                        <CommandItem
                                            key={choice.id}
                                            value={choice.id}
                                            // By the choice itself: the list trims the value it hands back.
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
