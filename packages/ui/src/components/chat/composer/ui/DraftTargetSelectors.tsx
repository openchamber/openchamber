/**
 * Where a new session will run: the project and the directory within it.
 *
 * Desktop uses inline selects; mobile uses bottom sheets, because a native
 * select over a keyboard-resized viewport is unusable. Both render the same
 * options from the same hook, and both offer creating a worktree inline so the
 * user does not have to leave the draft to make one.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
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
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { createWorktreeDraft } from '@/lib/worktreeSessionCreator';
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
export function DraftTargetSelectors(props: DraftTargetProps) {
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
        showBranchSelector,
        onProjectChange,
        onDirectoryChange,
        theme,
    } = props;

    return (
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 px-0.5">
            <Select
                value={selectedProject.id}
                onValueChange={onProjectChange}
            >
                <SelectTrigger
                    size="sm"
                    className="h-7 min-w-0 w-fit max-w-[42vw] sm:max-w-[18rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                >
                    <SelectValue>
                        {selectedProject.kind === 'chat'
                            ? <span className="truncate">{t('chat.chatInput.chooseProject')}</span>
                            : <ProjectLabel project={selectedProject} theme={theme} />}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent side="top" collisionAvoidance={{ side: 'none' }} fitContent>
                    {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
                            <ProjectLabel project={project} theme={theme} />
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {showBranchSelector ? (
                <Select
                    value={selectedDirectory ?? branchItems[0]?.value ?? normalizePath(selectedProject.path) ?? ''}
                    onValueChange={onDirectoryChange}
                >
                    <SelectTrigger
                        size="sm"
                        className="h-7 min-w-0 w-fit max-w-[48vw] sm:max-w-[20rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                    >
                        <SelectValue>
                            {selectedBranchLabel ?? t('chat.chatInput.branch')}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent side="top" collisionAvoidance={{ side: 'none' }} className="w-max min-w-48">
                        {projectRootBranchOption ? (
                            <SelectGroup>
                                <SelectLabel>{t('chat.chatInput.projectRoot')}</SelectLabel>
                                <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} className="max-w-[24rem] truncate">
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
                                <SelectItem key={option.value} value={option.value} className="max-w-[24rem] truncate">
                                    {option.pending ? '⏳ ' : ''}{option.label}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                        {selectedDirectory && !selectedBranchIsKnown ? (
                            <SelectItem value={selectedDirectory} className="max-w-[24rem] truncate">
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
                    ? <span className="truncate">{t('chat.chatInput.chooseProject')}</span>
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
                        {projects
                            .filter((project) => {
                                const needle = query.trim().toLowerCase();
                                if (!needle) return true;
                                return getProjectDisplayLabel(project).toLowerCase().includes(needle)
                                    || project.path.toLowerCase().includes(needle);
                            })
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
                            const needle = query.trim().toLowerCase();
                            const matches = (label: string) => !needle || label.toLowerCase().includes(needle);
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
                                    {worktreeBranchOptions
                                        .filter((option) => matches(option.label))
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
