/**
 * The board's scope pickers, drawn like the draft composer's project picker:
 * a quiet trigger with the project's icon and name, and a searchable list.
 */

import * as React from 'react';
import { Popover } from '@base-ui/react/popover';

import { ProjectLabel, ProjectPickerSheet } from '@/components/chat/composer/ui/DraftTargetSelectors';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectEntry, TrackerContainer } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn, formatDirectoryName } from '@/lib/utils';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { useTrackerAuthEntry, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';

import { repositoryLabel } from './boardRepository';

const projectName = (project: ProjectEntry): string => project.label?.trim() || formatDirectoryName(project.path) || project.path;

/** `toolbar`: the board's scope, beside the search. `inline`: a smaller one inside a sentence. */
type PickerSize = 'toolbar' | 'inline';

const TRIGGER_CLASS = {
    toolbar: 'h-7 max-w-[16rem] px-2 typography-ui-label font-medium',
    inline: 'h-7 max-w-[14rem] px-1.5 typography-meta',
} as const satisfies Record<PickerSize, string>;

export const SourceBoardProjectPicker: React.FC<{
    projects: readonly ProjectEntry[];
    selected: ProjectEntry;
    onSelect: (projectId: string) => void;
    ariaLabel: string;
    size: PickerSize;
    /** The phone shell picks from a bottom sheet: a popup there cannot scroll far enough for a long list. */
    sheet?: boolean;
}> = ({ projects, selected, onSelect, ariaLabel, size, sheet = false }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const orderedProjects = useProjectsInSidebarOrder(projects, open);
    const ranked = React.useMemo(
        () => (query ? rankByQuery([...orderedProjects], query, (project) => [projectName(project), project.path]) : [...orderedProjects]),
        [orderedProjects, query],
    );
    const effectiveActive = activeId && ranked.some((project) => project.id === activeId) ? activeId : ranked[0]?.id ?? null;

    const choose = (projectId: string) => {
        onSelect(projectId);
        setOpen(false);
    };

    if (sheet) {
        return (
            <>
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label={ariaLabel}
                    aria-haspopup="dialog"
                    onClick={() => setOpen(true)}
                    className={cn('min-w-0 w-fit shrink-0 justify-start gap-1 normal-case', TRIGGER_CLASS[size])}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <ProjectLabel project={selected} theme={currentTheme} />
                        <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
                    </span>
                </Button>
                <ProjectPickerSheet
                    open={open}
                    onClose={() => setOpen(false)}
                    projects={orderedProjects}
                    selectedProjectId={selected.id}
                    onSelectProject={choose}
                    theme={currentTheme}
                    title={ariaLabel}
                    searchPlaceholder={t('chat.chatInput.draftPicker.searchProjects')}
                />
            </>
        );
    }

    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                setQuery('');
                setActiveId(next ? selected.id : null);
            }}
            onOpenChangeComplete={(next) => { if (next) searchRef.current?.focus(); }}
        >
            <Popover.Trigger
                render={
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-label={ariaLabel}
                        aria-haspopup="dialog"
                        className={cn('min-w-0 w-fit shrink-0 justify-start gap-1 normal-case data-[popup-open]:bg-interactive-hover', TRIGGER_CLASS[size])}
                    />
                }
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    <ProjectLabel project={selected} theme={currentTheme} />
                    <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
                </span>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
                    <Popover.Popup
                        role="dialog"
                        aria-label={ariaLabel}
                        className={cn(dropdownMenuPopupClass, 'flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0')}
                        initialFocus={false}
                    >
                        <Command className="min-h-0 flex-1" shouldFilter={false} value={effectiveActive ?? undefined} onValueChange={setActiveId}>
                            <CommandInput
                                ref={searchRef}
                                aria-label={t('chat.chatInput.draftPicker.searchProjects')}
                                placeholder={t('chat.chatInput.draftPicker.searchProjects')}
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
                                {ranked.length === 0 ? (
                                    <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">
                                        {t('chat.chatInput.draftPicker.noProjectsFound')}
                                    </div>
                                ) : ranked.map((project) => (
                                    <CommandItem key={project.id} value={project.id} onSelect={choose} aria-current={project.id === selected.id ? true : undefined} className="max-w-full">
                                        <span className="min-w-0 flex-1 truncate"><ProjectLabel project={project} theme={currentTheme} /></span>
                                        {project.id === selected.id ? <Icon name="check" className="size-4 shrink-0 text-muted-foreground" /> : null}
                                    </CommandItem>
                                ))}
                            </CommandList>
                        </Command>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
};

/** One entry of the repository picker: a repository's folder, or null for all of them. */
type RepositoryEntry = { value: string; repository: string | null; label: string };

/**
 * Which repository under the project's folder the board lists, or all of them
 * together, shown beside the project picker while the folder is not a
 * repository itself.
 */
export const SourceBoardRepositoryPicker: React.FC<{
    repositories: readonly string[];
    /** The listed repository's folder; null while the board lists all of them. */
    selected: string | null;
    /** The project's folder the repository paths are shown relative to. */
    root: string;
    /** Offers "All repositories" first; not where the runtime cannot list across repositories. */
    allAvailable: boolean;
    /** A repository's folder, or null for all of them. */
    onSelect: (repository: string | null) => void;
    /** The phone shell picks from a bottom sheet, like the project picker. */
    sheet?: boolean;
}> = ({ repositories, selected, root, allAvailable, onSelect, sheet = false }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [activeValue, setActiveValue] = React.useState<string | null>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const ariaLabel = t('sourceBoard.repository.label');
    const searchLabel = t('sourceBoard.repository.search');
    const allLabel = t('sourceBoard.repository.all');
    const entries = React.useMemo<RepositoryEntry[]>(() => {
        const found = query
            ? rankByQuery([...repositories], query, (repository) => [repositoryLabel(repository, root)])
            : [...repositories];
        const repositoryEntries = found.map((repository) => ({ value: `repository:${repository}`, repository, label: repositoryLabel(repository, root) }));
        return allAvailable && !query ? [{ value: 'all', repository: null, label: allLabel }, ...repositoryEntries] : repositoryEntries;
    }, [allAvailable, allLabel, query, repositories, root]);
    const selectedValue = selected === null ? 'all' : `repository:${selected}`;
    const effectiveActive = activeValue && entries.some((entry) => entry.value === activeValue) ? activeValue : entries[0]?.value ?? null;
    const choose = (entry: RepositoryEntry) => {
        onSelect(entry.repository);
        setOpen(false);
        setQuery('');
    };
    // Not shrink-0 like the project picker: beside it, this is the one that truncates.
    const triggerClass = cn('min-w-0 w-fit justify-start gap-1 normal-case data-[popup-open]:bg-interactive-hover', TRIGGER_CLASS.toolbar);
    const triggerContent = (
        <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="folder-3" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{selected === null ? allLabel : repositoryLabel(selected, root)}</span>
            <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
        </span>
    );

    if (sheet) {
        return (
            <>
                <Button variant="ghost" size="sm" aria-label={ariaLabel} aria-haspopup="dialog" onClick={() => setOpen(true)} className={triggerClass}>
                    {triggerContent}
                </Button>
                <MobileOverlayPanel open={open} title={ariaLabel} onClose={() => { setOpen(false); setQuery(''); }}>
                    <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
                        <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={searchLabel} placeholder={searchLabel} className="h-9" />
                        <div className="flex flex-col">
                            {entries.length === 0 ? (
                                <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">{t('sourceBoard.repository.noneFound')}</div>
                            ) : entries.map((entry) => (
                                <button
                                    key={entry.value}
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                                    onClick={() => choose(entry)}
                                >
                                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                    {entry.value === selectedValue ? <Icon name="check" className="size-4 shrink-0 text-muted-foreground" /> : null}
                                </button>
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
            onOpenChange={(next) => {
                setOpen(next);
                setQuery('');
                setActiveValue(next ? selectedValue : null);
            }}
            onOpenChangeComplete={(next) => { if (next) searchRef.current?.focus(); }}
        >
            <Popover.Trigger render={<Button variant="ghost" size="sm" aria-label={ariaLabel} aria-haspopup="dialog" className={triggerClass} />}>
                {triggerContent}
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
                    <Popover.Popup role="dialog" aria-label={ariaLabel} className={cn(dropdownMenuPopupClass, 'flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0')} initialFocus={false}>
                        <Command className="min-h-0 flex-1" shouldFilter={false} value={effectiveActive ?? undefined} onValueChange={setActiveValue}>
                            <CommandInput
                                ref={searchRef}
                                aria-label={searchLabel}
                                placeholder={searchLabel}
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
                                {entries.length === 0 ? (
                                    <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">{t('sourceBoard.repository.noneFound')}</div>
                                ) : entries.map((entry) => (
                                    <CommandItem key={entry.value} value={entry.value} onSelect={() => choose(entry)} aria-current={entry.value === selectedValue ? true : undefined} className="max-w-full">
                                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                        {entry.value === selectedValue ? <Icon name="check" className="size-4 shrink-0 text-muted-foreground" /> : null}
                                    </CommandItem>
                                ))}
                            </CommandList>
                        </Command>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
};

const ALL_CONTAINERS = '__all__';
const NO_ACCOUNTS: readonly never[] = [];

/**
 * Which container (a Linear team) a tracker's tab lists, and which account
 * (a Linear workspace) when the tracker connects several: accounts are few
 * and switched rarely, so they share the menu. The containers come from the
 * tracker's project mapping; a tracker without either shows no picker.
 */
export const SourceBoardContainerPicker: React.FC<{
    provider: string;
    containers: readonly TrackerContainer[];
    selectedContainerId: string | null;
    onSelectContainer: (containerId: string | null) => void;
    onAccountSwitched: () => void;
}> = ({ provider, containers, selectedContainerId, onSelectContainer, onAccountSwitched }) => {
    const { t } = useI18n();
    const { trackers } = useRuntimeAPIs();
    const descriptor = useTrackerDescriptor(provider);
    const { icon, copy } = trackerPresentation(provider);
    const status = useTrackerAuthEntry(provider).status;
    const accounts = status?.connected ? status.accounts ?? NO_ACCOUNTS : NO_ACCOUNTS;
    const current = accounts.find((account) => account.current) ?? null;
    const [switching, setSwitching] = React.useState(false);
    const accountName = (account: (typeof accounts)[number]) => account.name?.trim() || account.id;
    const canSwitch = descriptor.capabilities.multipleAccounts && accounts.length > 1 && Boolean(current) && Boolean(trackers);
    const containerName = containers.find((container) => container.id === selectedContainerId)?.name ?? t(copy.containerAll);

    if (!descriptor.capabilities.projectMapping && !canSwitch) return null;

    const activate = async (accountId: string) => {
        if (!current || accountId === current.id || switching || !trackers) return;
        setSwitching(true);
        try {
            useTrackerAuthStore.getState().setStatus(provider, await trackers.authActivate(provider, accountId));
            onAccountSwitched();
            toast.success(t(copy.accountSwitched));
        } catch (error) {
            toast.error(t(copy.accountSwitchFailed), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setSwitching(false);
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t(copy.containerLabel)}
                    disabled={switching}
                    className={cn('min-w-0 w-fit shrink-0 justify-start gap-1 normal-case data-[popup-open]:bg-interactive-hover', TRIGGER_CLASS.toolbar)}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Icon name={icon} className="size-3.5 shrink-0" />
                        {canSwitch && current ? <span className="truncate text-muted-foreground">{accountName(current)} /</span> : null}
                        <span className="truncate">{containerName}</span>
                        <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
                    </span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>{t(copy.containerLabel)}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={selectedContainerId ?? ALL_CONTAINERS} onValueChange={(value) => onSelectContainer(value === ALL_CONTAINERS ? null : String(value))}>
                    <DropdownMenuRadioItem value={ALL_CONTAINERS}>{t(copy.containerAll)}</DropdownMenuRadioItem>
                    {containers.map((container) => <DropdownMenuRadioItem key={container.id} value={container.id}>{container.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                {canSwitch && current ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t(copy.accountLabel)}</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={current.id} onValueChange={(value) => void activate(String(value))}>
                            {accounts.map((account) => <DropdownMenuRadioItem key={account.id} value={account.id}>{accountName(account)}</DropdownMenuRadioItem>)}
                        </DropdownMenuRadioGroup>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
