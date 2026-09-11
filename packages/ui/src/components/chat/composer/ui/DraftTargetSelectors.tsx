/**
 * Where a new session will run: the project and the directory within it.
 *
 * Desktop uses a searchable project popup and an inline branch/worktree
 * select; mobile uses bottom sheets, because a native select over a
 * keyboard-resized viewport is unusable. Both render the same options from
 * the same hook, and both offer creating a worktree inline so the user does
 * not have to leave the draft to make one.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import {
    Command,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import { handleDropdownNavigationKey, shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { isIMECompositionEvent } from '@/lib/ime';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { matchesRankQuery, rankByQuery } from '@/lib/search/fuzzySearch';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { createWorktreeDraft } from '@/lib/worktreeSessionCreator';
import { shortcutRegistry } from '@/lib/shortcuts';
import { useKeybind } from '@/hooks/useKeybind';
import type { Theme } from '@/types/theme';
import { normalizePath } from '../attachments/filePaths';
import { getProjectDisplayLabel, type DraftTargetProject } from '../state/useDraftTarget';

export interface BranchOption {
    value: string;
    label: string;
    pending?: boolean;
}

export interface DraftTargetProps {
    projects: readonly DraftTargetProject[];
    selectedProject: DraftTargetProject;
    selectedDirectory: string | null;
    selectedBranchLabel: string | null;
    selectedBranchIsKnown: boolean;
    hasUncommittedChanges: boolean;
    /**
     * Whether the dirty warning may announce itself by opening its tooltip
     * unprompted. Off for a draft the app opened on its own at boot: that
     * draft is often only a placeholder until the last session restores, and
     * a tooltip on an otherwise empty screen reads as a glitch. The warning
     * icon still shows on desktop and the tooltip stays reachable by hover.
     */
    announceDirtyState: boolean;
    projectRootBranchOption: BranchOption | null;
    worktreeBranchOptions: readonly BranchOption[];
    branchItems: readonly BranchOption[];
    showBranchSelector: boolean;
    onProjectChange: (projectId: string) => void;
    onDirectoryChange: (directory: string) => void;
    theme: Theme;
}

const getProjectIconColor = (projectColor?: string | null): string | undefined =>
    projectColor ? PROJECT_COLOR_MAP[projectColor] ?? undefined : undefined;

/** A project's icon (custom image, configured icon, or a folder) plus its name. */
function ProjectLabel({ project, theme }: { project: DraftTargetProject; theme: Theme }) {
    const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = getProjectIconColor(project.color);
    const fallbackIcon = project.kind === 'chat' ? (
        <Icon name="chat-4" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
    ) : projectIconName ? (
        <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
    ) : (
        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
    );

    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            {project.iconImage ? (
                <span
                    className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
                    style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
                >
                    <ProjectIconImage
                        project={{ id: project.id, iconImage: project.iconImage ?? null }}
                        options={{
                            themeVariant: theme.metadata.variant,
                            iconColor: theme.colors.surface.foreground,
                        }}
                        className="h-full w-full object-contain"
                        fallback={fallbackIcon}
                    />
                </span>
            ) : fallbackIcon}
            <span className="truncate">{getProjectDisplayLabel(project)}</span>
        </span>
    );
}

/** Desktop: inline project and branch selects. */
/** How long the dirty-directory tooltip announces itself before becoming hover-only. */
const DIRTY_TOOLTIP_FLASH_MS = 5000;

/**
 * Opens the tooltip for a few seconds when the dirty state first appears, so
 * the warning is seen without hovering, then hands control back to hover.
 * Only when the draft may announce itself — see `announceDirtyState`.
 */
function useDirtyFlashTooltip(hasUncommittedChanges: boolean, announce: boolean) {
    const [open, setOpen] = React.useState(false);

    React.useEffect(() => {
        if (!hasUncommittedChanges || !announce) {
            setOpen(false);
            return;
        }
        setOpen(true);
        const timer = window.setTimeout(() => setOpen(false), DIRTY_TOOLTIP_FLASH_MS);
        return () => window.clearTimeout(timer);
    }, [announce, hasUncommittedChanges]);

    return { open, onOpenChange: setOpen };
}

export function DraftTargetSelectors(props: DraftTargetProps) {
    const { t } = useI18n();
    const dirtyTooltip = useDirtyFlashTooltip(props.hasUncommittedChanges, props.announceDirtyState);
    const {
        projects,
        selectedProject,
        selectedDirectory,
        selectedBranchLabel,
        selectedBranchIsKnown,
        hasUncommittedChanges,
        projectRootBranchOption,
        worktreeBranchOptions,
        branchItems,
        showBranchSelector,
        onProjectChange,
        onDirectoryChange,
        theme,
    } = props;
    const [openPicker, setOpenPicker] = React.useState<'project' | 'worktree' | null>(null);
    const [projectQuery, setProjectQuery] = React.useState('');
    const [projectActiveId, setProjectActiveId] = React.useState<string | null>(null);
    const [projectFocusReturn, setProjectFocusReturn] = React.useState(false);
    const projectTriggerRef = React.useRef<HTMLButtonElement>(null);
    const worktreeTriggerRef = React.useRef<HTMLButtonElement>(null);
    // Controlled Select closes can omit finalFocus's interaction type.
    const keyboardCloseRef = React.useRef(false);
    const getComposerInput = () => projectTriggerRef.current?.closest('form')?.querySelector<HTMLElement>('[data-chat-input="true"] .cm-content');
    const getFinalFocus = () => keyboardCloseRef.current ? getComposerInput() : true;
    const projectSearchRef = React.useRef<HTMLInputElement>(null);
    // Preserve Select's dialog portal and main-area containment.
    const [projectPortalContainer, setProjectPortalContainer] = React.useState<HTMLElement | null>(null);
    const [projectCollisionBoundary, setProjectCollisionBoundary] = React.useState<Element | null>(null);
    const syncProjectPopupContainers = React.useCallback((target: EventTarget | null) => {
        const element = target instanceof HTMLElement ? target : null;
        const dialog = element?.closest('[data-slot="dialog-content"], [role="dialog"]');
        setProjectPortalContainer(dialog instanceof HTMLElement ? dialog : null);
        setProjectCollisionBoundary(element?.closest('main') ?? null);
    }, []);
    // The popover owns no shortcut suspension (unlike Select/DropdownMenu
    // wrappers), so suspend global shortcuts while the project popup is
    // open and restore them on close/unmount.
    const projectSuspendRef = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        if (openPicker !== 'project') return;
        projectSuspendRef.current?.();
        projectSuspendRef.current = shortcutRegistry.suspend();
        return () => {
            projectSuspendRef.current?.();
            projectSuspendRef.current = null;
        };
    }, [openPicker]);
    const handlePickerKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
        if (openPicker === null || !shouldDismissDropdown(event)) return;
        event.preventDefault();
        event.stopPropagation();
        keyboardCloseRef.current = true;
        setOpenPicker(null);
    };

    useKeybind('open_draft_project_picker', () => {
        projectTriggerRef.current?.focus();
        setProjectFocusReturn(false);
        setProjectQuery('');
        setProjectActiveId(
            projects.some((project) => project.id === selectedProject.id) ? selectedProject.id : null,
        );
        setOpenPicker('project');
    });
    useKeybind('open_draft_worktree_picker', () => {
        if (!showBranchSelector) return false;
        worktreeTriggerRef.current?.focus();
        setOpenPicker('worktree');
    });

    const filteredProjects = React.useMemo(
        () => openPicker === 'project'
            ? rankByQuery(projects, projectQuery, (project) => [getProjectDisplayLabel(project), project.path])
            : projects,
        [openPicker, projects, projectQuery],
    );

    // Transient search must never survive to the next opening, including
    // picker switches and draft unmounts.
    React.useEffect(() => {
        if (openPicker !== 'project') {
            setProjectQuery('');
            setProjectActiveId(null);
        }
    }, [openPicker]);
    // After a query or project-list change, retain the active ID only
    // while it stays visible; otherwise fall to the first result (or none
    // when the list is empty) so Enter cannot commit a hidden row.
    React.useEffect(() => {
        if (openPicker !== 'project') return;
        setProjectActiveId((current) => {
            if (current && filteredProjects.some((project) => project.id === current)) return current;
            return filteredProjects[0]?.id ?? null;
        });
    }, [filteredProjects, openPicker]);

    const handleProjectChange = (projectId: string) => {
        onProjectChange(projectId);
        setProjectFocusReturn(true);
        setOpenPicker(null);
    };

    const handleProjectSelect = (projectId: string) => {
        if (!filteredProjects.some((project) => project.id === projectId)) return;
        handleProjectChange(projectId);
    };

    const handleDirectoryChange = (directory: string) => {
        onDirectoryChange(directory);
        setOpenPicker(null);
    };

    return (
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 px-0.5">
            {/* Plain popover (not a menu): the popup owns a combobox +
                listbox, so menu/menuitem semantics would be wrong here. */}
            <Popover.Root
                open={openPicker === 'project'}
                onOpenChange={(open, eventDetails) => {
                    if (open) {
                        setProjectFocusReturn(false);
                        // Seed the active row from the committed project so
                        // Enter without typing repeats the current choice.
                        // The clamp below keeps it when still visible and
                        // falls to the first result otherwise.
                        setProjectQuery('');
                        setProjectActiveId(
                            projects.some((project) => project.id === selectedProject.id)
                                ? selectedProject.id
                                : null,
                        );
                        setOpenPicker('project');
                        return;
                    }
                    setProjectQuery('');
                    setProjectActiveId(null);
                    const reason = eventDetails?.reason;
                    setProjectFocusReturn(reason === 'escape-key');
                    setOpenPicker(null);
                }}
                onOpenChangeComplete={(open) => {
                    // Return focus after Base UI finishes closing so typing
                    // continues in this form's composer, including reselection.
                    if (!open && projectFocusReturn) {
                        (getComposerInput() ?? projectTriggerRef.current)?.focus();
                        setProjectFocusReturn(false);
                    }
                    // Focus the search once the popup mounts; the opening
                    // shortcut focuses the trigger first.
                    if (open && openPicker === 'project') projectSearchRef.current?.focus();
                }}
            >
                <Popover.Trigger
                    render={
                        <Button
                            ref={projectTriggerRef}
                            variant="ghost"
                            size="sm"
                            aria-haspopup="dialog"
                            className="h-7 min-w-0 w-fit max-w-[42vw] justify-start gap-1 px-1.5 normal-case sm:max-w-[18rem]"
                            onPointerDownCapture={(event) => syncProjectPopupContainers(event.currentTarget)}
                            onFocusCapture={(event) => syncProjectPopupContainers(event.currentTarget)}
                        />
                    }
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        {selectedProject.kind === 'chat'
                            ? <span className="truncate typography-ui-label">{t('chat.chatInput.chooseProject')}</span>
                            : <ProjectLabel project={selectedProject} theme={theme} />}
                        <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
                    </span>
                </Popover.Trigger>
                <Popover.Portal container={projectPortalContainer ?? undefined}>
                    {/* side="bottom" anchors the popup's top edge at the
                        trigger: the search field stays fixed at the
                        selector's level while filtering, and only the
                        results area below changes height. Disabling side
                        flips keeps the input stationary during filtering.
                        Horizontal shifting keeps the popup inside main. The
                        --available-height cap comes free from the shared
                        popup class, so the list scrolls within the space
                        below the trigger. */}
                    <Popover.Positioner
                        side="bottom"
                        align="start"
                        sideOffset={4}
                        collisionAvoidance={{ side: 'none' }}
                        collisionBoundary={projectCollisionBoundary ?? undefined}
                        className="app-region-no-drag z-50"
                    >
                        <Popover.Popup
                            role="dialog"
                            aria-label={t('chat.chatInput.draftPicker.projectTitle')}
                            className={cn(dropdownMenuPopupClass, 'flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0')}
                            initialFocus={false}
                            finalFocus={false}
                        >
                            {/* Filtering and ordering are owned by rankByQuery above;
                                cmdk's own filter would re-filter and reorder the
                                already-ranked rows. */}
                            <Command
                                className="min-h-0 flex-1"
                                shouldFilter={false}
                                value={projectActiveId ?? undefined}
                                onValueChange={setProjectActiveId}
                            >
                                <CommandInput
                                    ref={projectSearchRef}
                                    aria-label={t('chat.chatInput.draftPicker.searchProjects')}
                                    placeholder={t('chat.chatInput.draftPicker.searchProjects')}
                                    value={projectQuery}
                                    onValueChange={setProjectQuery}
                                    onKeyDown={(event) => {
                                        // Command owns active-item navigation, so only
                                        // translate the repository's Ctrl+N/P
                                        // convention into arrows at the input.
                                        // IME-composing keys must never move the
                                        // active row or dismiss the popup.
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
                                <CommandList label={t('chat.chatInput.draftPicker.projectTitle')}>
                                    {filteredProjects.length === 0 ? (
                                        <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">
                                            {t('chat.chatInput.draftPicker.noProjectsFound')}
                                        </div>
                                    ) : (
                                        filteredProjects.map((project) => (
                                            <CommandItem
                                                key={project.id}
                                                value={project.id}
                                                onSelect={handleProjectSelect}
                                                aria-current={project.id === selectedProject.id ? true : undefined}
                                                className="max-w-full"
                                            >
                                                <span className="min-w-0 flex-1 truncate">
                                                    <ProjectLabel project={project} theme={theme} />
                                                </span>
                                                {project.id === selectedProject.id ? (
                                                    <Icon name="check" className="size-4 shrink-0 text-muted-foreground" />
                                                ) : null}
                                            </CommandItem>
                                        ))
                                    )}
                                </CommandList>
                            </Command>
                        </Popover.Popup>
                    </Popover.Positioner>
                </Popover.Portal>
            </Popover.Root>

            {showBranchSelector ? (
                <Select
                    value={selectedDirectory ?? branchItems[0]?.value ?? normalizePath(selectedProject.path) ?? ''}
                    open={openPicker === 'worktree'}
                    onOpenChange={(open, details) => {
                        keyboardCloseRef.current = !open && details.event.type === 'keydown';
                        setOpenPicker(open ? 'worktree' : null);
                    }}
                    onValueChange={handleDirectoryChange}
                    disableGlobalShortcuts
                >
                    <Tooltip open={dirtyTooltip.open} onOpenChange={dirtyTooltip.onOpenChange}>
                        <TooltipTrigger asChild>
                            <SelectTrigger
                                ref={worktreeTriggerRef}
                                onKeyDown={handlePickerKeyDown}
                                size="sm"
                                className="h-7 min-w-0 w-fit max-w-[48vw] sm:max-w-[20rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                            >
                                {hasUncommittedChanges ? (
                                    <Icon
                                        name="alert"
                                        className="size-3.5 shrink-0 text-[var(--status-warning)]"
                                        aria-label={t('chat.draftDirtyNotice.indicatorAria')}
                                    />
                                ) : null}
                                <SelectValue>
                                    {selectedBranchLabel ?? t('chat.chatInput.branch')}
                                </SelectValue>
                            </SelectTrigger>
                        </TooltipTrigger>
                        {hasUncommittedChanges ? (
                            <TooltipContent showArrow side="top" sideOffset={8} className="max-w-72">
                                <span className="block whitespace-pre-line">{t('chat.draftDirtyNotice.tooltip')}</span>
                            </TooltipContent>
                        ) : null}
                    </Tooltip>
                    <SelectContent side="top" collisionAvoidance={{ side: 'none' }} constrainToMain className="w-max min-w-48" onKeyDown={handlePickerKeyDown} finalFocus={getFinalFocus}>
                        {projectRootBranchOption ? (
                            <SelectGroup>
                                <SelectLabel>{t('chat.chatInput.projectRoot')}</SelectLabel>
                                <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} showSelectedBackground={false} className="max-w-[24rem] truncate">
                                    {projectRootBranchOption.label}
                                </SelectItem>
                            </SelectGroup>
                        ) : null}
                        {projectRootBranchOption ? <SelectSeparator /> : null}
                        <SelectGroup>
                            <div className="flex items-center justify-between px-2 py-1.5">
                                <span className="text-muted-foreground typography-meta">{t('chat.chatInput.worktrees')}</span>
                                <button
                                    type="button"
                                    className="text-muted-foreground typography-meta hover:text-foreground cursor-pointer"
                                    onPointerDown={(e) => { e.stopPropagation(); }}
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); void createWorktreeDraft(); }}
                                >
                                    {t('chat.chatInput.worktreeNew')}
                                </button>
                            </div>
                            {worktreeBranchOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value} showSelectedBackground={false} className="max-w-[24rem] truncate">
                                    {option.pending ? '⏳ ' : ''}{option.label}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                        {selectedDirectory && !selectedBranchIsKnown ? (
                            <SelectItem value={selectedDirectory} showSelectedBackground={false} className="max-w-[24rem] truncate">
                                {selectedBranchLabel}
                            </SelectItem>
                        ) : null}
                    </SelectContent>
                </Select>
            ) : null}
        </div>
    );
}

/** Mobile: buttons that open the bottom sheets below. */
export function MobileDraftTargetTriggers(
    props: Pick<DraftTargetProps, 'selectedProject' | 'selectedBranchLabel' | 'showBranchSelector' | 'theme'>
        & { onOpenPicker: (picker: 'project' | 'branch') => void },
) {
    const { t } = useI18n();
    const { selectedProject, selectedBranchLabel, showBranchSelector, theme, onOpenPicker } = props;

    return (
        <div className="mb-1.5 flex min-w-0 items-center gap-x-2 px-0.5">
            <button
                type="button"
                className="inline-flex h-7 min-w-0 max-w-[42vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                onClick={() => onOpenPicker('project')}
            >
                {selectedProject.kind === 'chat'
                    ? <span className="truncate typography-ui-label">{t('chat.chatInput.chooseProject')}</span>
                    : <ProjectLabel project={selectedProject} theme={theme} />}
                <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            </button>
            {showBranchSelector ? (
                <button
                    type="button"
                    className="inline-flex h-7 min-w-0 max-w-[48vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                    onClick={() => onOpenPicker('branch')}
                >
                    <span className="truncate">{selectedBranchLabel ?? t('chat.chatInput.branch')}</span>
                    <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                </button>
            ) : null}
        </div>
    );
}

/**
 * Mobile: the project and branch sheets. Bottom sheets rather than selects
 * because a native select over a keyboard-resized viewport is unusable.
 */
export function MobileDraftTargetSheets(
    props: DraftTargetProps & {
        openPicker: 'project' | 'branch' | null;
        onOpenPickerChange: (picker: 'project' | 'branch' | null) => void;
        query: string;
        onQueryChange: (query: string) => void;
    },
) {
    const { t } = useI18n();
    const {
        projects,
        selectedProject,
        selectedDirectory,
        selectedBranchLabel,
        selectedBranchIsKnown,
        projectRootBranchOption,
        worktreeBranchOptions,
        branchItems,
        onProjectChange,
        onDirectoryChange,
        openPicker,
        onOpenPickerChange,
        query,
        onQueryChange,
        theme,
    } = props;

    return (
        <>
            <MobileOverlayPanel
                open={openPicker === 'project'}
                title={t('chat.chatInput.draftPicker.projectTitle')}
                onClose={() => onOpenPickerChange(null)}
            >
                <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
                    <Input
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                        placeholder={t('chat.chatInput.draftPicker.searchProjects')}
                        className="h-9"
                    />
                    <div className="flex flex-col">
                        {rankByQuery(projects, query, (project) => [getProjectDisplayLabel(project), project.path])
                            .map((project) => (
                                <button
                                    key={project.id}
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                                    onClick={() => {
                                        onProjectChange(project.id);
                                        onOpenPickerChange(null);
                                    }}
                                >
                                    <span className="min-w-0 flex-1"><ProjectLabel project={project} theme={theme} /></span>
                                    {project.id === selectedProject.id ? (
                                        <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                    ) : null}
                                </button>
                            ))}
                    </div>
                </div>
            </MobileOverlayPanel>
            <MobileOverlayPanel
                open={openPicker === 'branch'}
                title={t('chat.chatInput.branch')}
                onClose={() => onOpenPickerChange(null)}
            >
                <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
                    <Input
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                        placeholder={t('chat.chatInput.draftPicker.searchBranches')}
                        className="h-9"
                    />
                    <div className="flex flex-col">
                        {(() => {
                            const matches = (label: string) => matchesRankQuery([label], query);
                            const selectedValue = selectedDirectory
                                ?? branchItems[0]?.value
                                ?? normalizePath(selectedProject.path)
                                ?? '';
                            const renderRow = (value: string, label: React.ReactNode, key?: string) => (
                                <button
                                    key={key ?? value}
                                    type="button"
                                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                                    onClick={() => {
                                        onDirectoryChange(value);
                                        onOpenPickerChange(null);
                                    }}
                                >
                                    <span className="min-w-0 flex-1 truncate">{label}</span>
                                    {value === selectedValue ? (
                                        <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                    ) : null}
                                </button>
                            );
                            return (
                                <>
                                    {projectRootBranchOption && matches(projectRootBranchOption.label) ? (
                                        <>
                                            <div className="px-2 pb-1 pt-1.5 text-muted-foreground typography-meta">
                                                {t('chat.chatInput.projectRoot')}
                                            </div>
                                            {renderRow(projectRootBranchOption.value, projectRootBranchOption.label)}
                                        </>
                                    ) : null}
                                    <div className="flex items-center justify-between px-2 pb-1 pt-2">
                                        <span className="text-muted-foreground typography-meta">{t('chat.chatInput.worktrees')}</span>
                                        <button
                                            type="button"
                                            className="cursor-pointer text-muted-foreground typography-meta hover:text-foreground"
                                            onClick={() => {
                                                onOpenPickerChange(null);
                                                void createWorktreeDraft();
                                            }}
                                        >
                                            {t('chat.chatInput.worktreeNew')}
                                        </button>
                                    </div>
                                    {rankByQuery(worktreeBranchOptions, query, (option) => [option.label])
                                        .map((option) => renderRow(option.value, `${option.pending ? '⏳ ' : ''}${option.label}`))}
                                    {selectedDirectory && !selectedBranchIsKnown && matches(selectedBranchLabel ?? '')
                                        ? renderRow(selectedDirectory, selectedBranchLabel, 'unknown-current')
                                        : null}
                                </>
                            );
                        })()}
                    </div>
                </div>
            </MobileOverlayPanel>
        </>
    );
}
