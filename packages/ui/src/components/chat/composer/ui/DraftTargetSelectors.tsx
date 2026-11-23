
import React from 'react';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch, MobileSheetSection } from '@/components/ui/MobileSheetList';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { commandSearchAtBottomClass, usePopupSideOnOpen } from '@/components/ui/popup-side';
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
import { PROJECT_ICON_MAP, resolveProjectColor, ProjectIconImage } from '@/lib/projectMeta';
import { createWorktreeDraft } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo, shortcutRegistry } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { useUIStore } from '@/stores/useUIStore';
import { useKeybind } from '@/hooks/useKeybind';
import type { Theme } from '@/types/theme';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { normalizePath } from '../attachments/filePaths';
import { getProjectDisplayLabel, type DraftTargetProject } from '../state/useDraftTarget';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { DraftsHerePicker } from './DraftsHerePicker';
import { sessionEvents } from '@/lib/sessionEvents';
import { DraftFolderTarget } from './DraftFolderTarget';
import { DraftKindToggle } from './DraftKindToggle';

const ADD_PROJECT_ITEM = '__add_project__';

interface BranchOption {
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
    projectRootBranchOption: BranchOption | null;
    worktreeBranchOptions: readonly BranchOption[];
    spaceBranchOptions: readonly BranchOption[];
    branchItems: readonly BranchOption[];
    showBranchSelector: boolean;
    onProjectChange: (projectId: string) => void;
    onDirectoryChange: (directory: string) => void;
    onRefreshTarget?: () => void;
    onCreateSpace?: () => void;
    onCreateCustomWorktree?: () => void;
    theme: Theme;
}

function WorktreeCreateActions({ onQuick, onCustom, className }: {
    onQuick: () => void;
    onCustom?: () => void;
    className: string;
}) {
    const { t } = useI18n();
    return (
        <>
            <button type="button" className={className} onPointerDown={(e) => { e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onQuick(); }}>
                <Icon name="flashlight" className="size-4 shrink-0 text-muted-foreground" />
                {t('chat.chatInput.worktreeQuick')}
            </button>
            {onCustom ? (
                <button type="button" className={className} onPointerDown={(e) => { e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCustom(); }}>
                    <Icon name="git-branch" className="size-4 shrink-0 text-muted-foreground" />
                    {t('chat.chatInput.worktreeCustom')}
                </button>
            ) : null}
        </>
    );
}

const getProjectIconColor = (projectColor?: string | null): string | undefined =>
    resolveProjectColor(projectColor) ?? undefined;

export function ProjectLabel({ project, theme }: { project: DraftTargetProject; theme: Theme }) {
    const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = getProjectIconColor(project.color);
    const fallbackIcon = project.kind === 'chat' ? (
        <Icon name="chat-4" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : projectIconName ? (
        <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
    ) : (
        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" style={iconColor ? { color: iconColor } : undefined} />
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
            <span dir="auto" className="truncate">{getProjectDisplayLabel(project)}</span>
        </span>
    );
}

function DraftTargetSelectorsView(props: DraftTargetProps) {
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const {
        projects,
        selectedProject,
        selectedDirectory,
        selectedBranchLabel,
        selectedBranchIsKnown,
        hasUncommittedChanges,
        projectRootBranchOption,
        worktreeBranchOptions,
        spaceBranchOptions,
        branchItems,
        showBranchSelector,
        onProjectChange,
        onDirectoryChange,
        onRefreshTarget,
        onCreateSpace,
        onCreateCustomWorktree,
        theme,
    } = props;
    const [openPicker, setOpenPicker] = React.useState<'project' | 'worktree' | null>(null);
    const selectedIsSpace = isSpaceDirectory(selectedDirectory);
    const [projectQuery, setProjectQuery] = React.useState('');
    const [projectActiveId, setProjectActiveId] = React.useState<string | null>(null);
    const [projectFocusReturn, setProjectFocusReturn] = React.useState(false);
    const projectTriggerRef = React.useRef<HTMLButtonElement>(null);
    const worktreeTriggerRef = React.useRef<HTMLButtonElement>(null);
    useWidthMorph(projectTriggerRef);
    useWidthMorph(worktreeTriggerRef);
    const keyboardCloseRef = React.useRef(false);
    const getComposerInput = () => projectTriggerRef.current?.closest('form')?.querySelector<HTMLElement>('[data-chat-input="true"] .cm-content');
    const getFinalFocus = () => keyboardCloseRef.current ? getComposerInput() : true;
    const projectSearchRef = React.useRef<HTMLInputElement>(null);
    const [projectPortalContainer, setProjectPortalContainer] = React.useState<HTMLElement | null>(null);
    const [projectCollisionBoundary, setProjectCollisionBoundary] = React.useState<Element | null>(null);
    const syncProjectPopupContainers = React.useCallback((target: EventTarget | null) => {
        const element = target instanceof HTMLElement ? target : null;
        const dialog = element?.closest('[data-slot="dialog-content"], [role="dialog"]');
        setProjectPortalContainer(dialog instanceof HTMLElement ? dialog : null);
        setProjectCollisionBoundary(element?.closest('main') ?? null);
    }, []);
    const projectPopupSide = usePopupSideOnOpen(openPicker === 'project', projectTriggerRef);
    const worktreePopupSide = usePopupSideOnOpen(openPicker === 'worktree', worktreeTriggerRef);
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
        onRefreshTarget?.();
        setOpenPicker('worktree');
    });

    const orderedProjects = useProjectsInSidebarOrder(projects, openPicker === 'project');
    const filteredProjects = React.useMemo(
        () => openPicker === 'project'
            ? rankByQuery(orderedProjects, projectQuery, (project) => [getProjectDisplayLabel(project), project.path])
            : orderedProjects,
        [openPicker, orderedProjects, projectQuery],
    );

    React.useEffect(() => {
        if (openPicker !== 'project') {
            setProjectQuery('');
            setProjectActiveId(null);
        }
    }, [openPicker]);
    React.useEffect(() => {
        if (openPicker !== 'project') return;
        setProjectActiveId((current) => {
            if (current && filteredProjects.some((project) => project.id === current)) return current;
            return filteredProjects[0]?.id ?? null;
        });
    }, [filteredProjects, openPicker]);

    const addProjectShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('add_project', shortcutOverrides), '');

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
            <Popover.Root
                open={openPicker === 'project'}
                onOpenChange={(open, eventDetails) => {
                    if (open) {
                        setProjectFocusReturn(false);
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
                    if (!open && projectFocusReturn) {
                        (getComposerInput() ?? projectTriggerRef.current)?.focus();
                        setProjectFocusReturn(false);
                    }
                    if (open && openPicker === 'project') projectSearchRef.current?.focus();
                }}
            >
                <Tooltip>
                <TooltipTrigger asChild>
                <Popover.Trigger
                    render={
                        <Button
                            ref={projectTriggerRef}
                            variant="ghost"
                            size="sm"
                            aria-haspopup="dialog"
                            className="h-7 min-w-0 w-fit max-w-[42vw] justify-start gap-1 overflow-hidden px-1.5 normal-case hover:bg-transparent data-[popup-open]:bg-transparent sm:max-w-[18rem]"
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
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                    <TooltipLabelWithShortcut label={t('chat.chatInput.draftPicker.projectTitle')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('open_draft_project_picker', shortcutOverrides), '')} />
                </TooltipContent>
                </Tooltip>
                <Popover.Portal container={projectPortalContainer ?? undefined}>
                    <Popover.Positioner
                        side={projectPopupSide}
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
                            <Command
                                className={cn(
                                    'min-h-0 flex-1',
                                    projectPopupSide === 'top' && commandSearchAtBottomClass,
                                )}
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
                                    <CommandItem
                                        value={ADD_PROJECT_ITEM}
                                        onSelect={() => {
                                            setOpenPicker(null);
                                            sessionEvents.requestDirectoryDialog();
                                        }}
                                        className="max-w-full"
                                    >
                                        <Icon name="folder-add" className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate">{t('chat.chatInput.draftPicker.addProject')}</span>
                                        {addProjectShortcut ? <span className="shrink-0 ps-3 typography-meta text-muted-foreground">{addProjectShortcut}</span> : null}
                                    </CommandItem>
                                </CommandList>
                            </Command>
                            <GlassRedrawGuard />
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
                        if (open) {
                            onRefreshTarget?.();
                        }
                        setOpenPicker(open ? 'worktree' : null);
                    }}
                    onValueChange={handleDirectoryChange}
                    disableGlobalShortcuts
                >
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <SelectTrigger
                                ref={worktreeTriggerRef}
                                onKeyDown={handlePickerKeyDown}
                                className="h-7 min-w-0 w-fit max-w-[48vw] overflow-hidden sm:max-w-[20rem] bg-transparent dark:bg-transparent shadow-none px-1.5 hover:[background-image:none] data-[popup-open]:[background-image:none]"
                            >
                                {selectedIsSpace ? <Icon name="instance" className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('sessions.sidebar.group.space')} /> : null}
                                <SelectValue>
                                    {selectedBranchLabel ?? t('chat.chatInput.branch')}
                                </SelectValue>
                                {hasUncommittedChanges ? (
                                    <Icon
                                        name="alert"
                                        className="size-3.5 shrink-0 text-[var(--status-warning)]"
                                        aria-label={t('chat.draftDirtyNotice.indicatorAria')}
                                    />
                                ) : null}
                            </SelectTrigger>
                        </TooltipTrigger>
                        <TooltipContent showArrow side="top" sideOffset={8} className="max-w-72">
                            <TooltipLabelWithShortcut label={t('chat.chatInput.branch')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('open_draft_worktree_picker', shortcutOverrides), '')} />
                            {hasUncommittedChanges ? <span className="block whitespace-pre-line">{t('chat.draftDirtyNotice.tooltip')}</span> : null}
                        </TooltipContent>
                    </Tooltip>
                    <SelectContent side={worktreePopupSide} align="start" sideOffset={4} collisionAvoidance={{ side: 'none' }} constrainToMain className="w-max min-w-48" onKeyDown={handlePickerKeyDown} finalFocus={getFinalFocus}>
                        {projectRootBranchOption ? (
                            <SelectGroup>
                                <SelectLabel>{t('chat.chatInput.projectRoot')}</SelectLabel>
                                <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} className="max-w-[24rem] truncate">
                                    {projectRootBranchOption.label}
                                </SelectItem>
                            </SelectGroup>
                        ) : null}
                        {projectRootBranchOption ? <SelectSeparator /> : null}
                        <WorktreeCreateActions
                            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                            onQuick={() => { setOpenPicker(null); void createWorktreeDraft(); }}
                            onCustom={onCreateCustomWorktree ? () => { setOpenPicker(null); onCreateCustomWorktree(); } : undefined}
                        />
                        {worktreeBranchOptions.length > 0 ? <SelectSeparator /> : null}
                        {worktreeBranchOptions.length > 0 ? <SelectGroup>
                            <SelectLabel>{t('chat.chatInput.worktrees')}</SelectLabel>
                            {worktreeBranchOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value} className="max-w-[24rem] truncate">
                                    {option.pending ? '⏳ ' : ''}{option.label}
                                </SelectItem>
                            ))}
                        </SelectGroup> : null}
                        {selectedDirectory && !selectedBranchIsKnown ? (
                            <SelectItem value={selectedDirectory} className="max-w-[24rem] truncate">
                                {selectedBranchLabel}
                            </SelectItem>
                        ) : null}
                        {spaceBranchOptions.length > 0 || onCreateSpace ? <SelectSeparator /> : null}
                        {spaceBranchOptions.length > 0 ? (
                            <SelectGroup>
                                <SelectLabel>{t('spaces.picker.section')}</SelectLabel>
                                {spaceBranchOptions.map((option) => (
                                    <SelectItem key={option.value} value={option.value} className="max-w-[24rem] truncate">
                                        <span className="inline-flex min-w-0 items-center gap-1.5">
                                            <Icon name="instance" className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span className="truncate">{option.label}</span>
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        ) : null}
                        {onCreateSpace ? (
                            <button
                                type="button"
                                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                                onPointerDown={(e) => { e.stopPropagation(); }}
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenPicker(null); onCreateSpace(); }}
                            >
                                <Icon name="add" className="size-4 shrink-0 text-muted-foreground" />
                                {t('spaces.picker.new')}
                            </button>
                        ) : null}
                    </SelectContent>
                </Select>
            ) : null}
            <DraftFolderTarget />
            <div className="ms-auto flex shrink-0 items-center gap-2">
                <DraftsHerePicker />
                <DraftKindToggle />
            </div>
        </div>
    );
}

interface ProjectPickerSheetProps {
    open: boolean;
    onClose: () => void;
    projects: readonly DraftTargetProject[];
    selectedProjectId: string;
    onSelectProject: (projectId: string) => void;
    theme: Theme;
    title: string;
    searchPlaceholder: string;
    addProjectLabel?: string;
}

export function ProjectPickerSheet({
    open,
    onClose,
    projects,
    selectedProjectId,
    onSelectProject,
    theme,
    title,
    searchPlaceholder,
    addProjectLabel,
}: ProjectPickerSheetProps) {
    const [query, setQuery] = React.useState('');

    React.useEffect(() => {
        setQuery('');
    }, [open]);

    return (
        <MobileOverlayPanel
            open={open}
            title={title}
            onClose={onClose}
            subheader={<MobileSheetSearch value={query} onChange={setQuery} placeholder={searchPlaceholder} />}
        >
            {rankByQuery(projects, query, (project) => [getProjectDisplayLabel(project), project.path])
                .map((project) => (
                    <MobileSheetRow
                        key={project.id}
                        selected={project.id === selectedProjectId}
                        onClick={() => {
                            onSelectProject(project.id);
                            onClose();
                        }}
                    >
                        <ProjectLabel project={project} theme={theme} />
                    </MobileSheetRow>
                ))}
            {addProjectLabel ? (
                <MobileSheetRow
                    icon="folder-add"
                    onClick={() => {
                        onClose();
                        sessionEvents.requestDirectoryDialog();
                    }}
                >
                    {addProjectLabel}
                </MobileSheetRow>
            ) : null}
        </MobileOverlayPanel>
    );
}

export function MobileDraftTargetSheets(
    props: DraftTargetProps & {
        openPicker: 'project' | 'branch' | null;
        onOpenPickerChange: (picker: 'project' | 'branch' | null) => void;
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
        spaceBranchOptions,
        branchItems,
        onProjectChange,
        onDirectoryChange,
        onCreateSpace,
        onCreateCustomWorktree,
        openPicker,
        onOpenPickerChange,
        theme,
    } = props;

    const [branchQuery, setBranchQuery] = React.useState('');
    const orderedProjects = useProjectsInSidebarOrder(projects, openPicker === 'project');

    React.useEffect(() => {
        setBranchQuery('');
    }, [openPicker]);

    return (
        <>
            <ProjectPickerSheet
                open={openPicker === 'project'}
                onClose={() => onOpenPickerChange(null)}
                projects={orderedProjects}
                selectedProjectId={selectedProject.id}
                onSelectProject={onProjectChange}
                theme={theme}
                title={t('chat.chatInput.draftPicker.projectTitle')}
                searchPlaceholder={t('chat.chatInput.draftPicker.searchProjects')}
                addProjectLabel={t('chat.chatInput.draftPicker.addProject')}
            />
            <MobileOverlayPanel
                open={openPicker === 'branch'}
                title={t('chat.chatInput.branch')}
                onClose={() => onOpenPickerChange(null)}
                subheader={<MobileSheetSearch value={branchQuery} onChange={setBranchQuery} placeholder={t('chat.chatInput.draftPicker.searchBranches')} />}
            >
                {(() => {
                    const matches = (label: string) => matchesRankQuery([label], branchQuery);
                    const selectedValue = selectedDirectory
                        ?? branchItems[0]?.value
                        ?? normalizePath(selectedProject.path)
                        ?? '';
                    const renderRow = (value: string, label: React.ReactNode, key?: string, icon?: IconName) => (
                        <MobileSheetRow
                            key={key ?? value}
                            icon={icon}
                            selected={value === selectedValue}
                            onClick={() => {
                                onDirectoryChange(value);
                                onOpenPickerChange(null);
                            }}
                        >
                            {label}
                        </MobileSheetRow>
                    );
                    return (
                        <>
                            {projectRootBranchOption && matches(projectRootBranchOption.label) ? (
                                <MobileSheetSection title={t('chat.chatInput.projectRoot')}>
                                    {renderRow(projectRootBranchOption.value, projectRootBranchOption.label)}
                                </MobileSheetSection>
                            ) : null}
                            <MobileSheetSection title={t('chat.chatInput.worktrees')}>
                                <MobileSheetRow icon="flashlight" onClick={() => { onOpenPickerChange(null); void createWorktreeDraft(); }}>
                                    {t('chat.chatInput.worktreeQuick')}
                                </MobileSheetRow>
                                {onCreateCustomWorktree ? (
                                    <MobileSheetRow icon="git-branch" onClick={() => { onOpenPickerChange(null); onCreateCustomWorktree(); }}>
                                        {t('chat.chatInput.worktreeCustom')}
                                    </MobileSheetRow>
                                ) : null}
                                {rankByQuery(worktreeBranchOptions, branchQuery, (option) => [option.label])
                                    .map((option) => renderRow(option.value, `${option.pending ? '⏳ ' : ''}${option.label}`))}
                                {selectedDirectory && !selectedBranchIsKnown && matches(selectedBranchLabel ?? '')
                                    ? renderRow(selectedDirectory, selectedBranchLabel, 'unknown-current')
                                    : null}
                            </MobileSheetSection>
                            {spaceBranchOptions.length > 0 || onCreateSpace ? (
                                <MobileSheetSection title={t('spaces.picker.section')}>
                                    {rankByQuery(spaceBranchOptions, branchQuery, (option) => [option.label])
                                        .map((option) => renderRow(option.value, option.label, undefined, 'instance'))}
                                    {onCreateSpace ? (
                                        <MobileSheetRow icon="add"
                                            onClick={() => {
                                                onOpenPickerChange(null);
                                                onCreateSpace();
                                            }}
                                        >
                                            {t('spaces.picker.new')}
                                        </MobileSheetRow>
                                    ) : null}
                                </MobileSheetSection>
                            ) : null}
                        </>
                    );
                })()}
            </MobileOverlayPanel>
        </>
    );
}

export const DraftTargetSelectors = React.memo(DraftTargetSelectorsView);
