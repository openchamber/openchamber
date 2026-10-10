/**
 * The board's scope pickers, drawn like the draft composer's project picker:
 * a quiet trigger with the project's icon and name, and a searchable list.
 */

import * as React from 'react';
import { Popover } from '@base-ui/react/popover';

import { ProjectLabel, ProjectPickerSheet } from '@/components/chat/composer/ui/DraftTargetSelectors';
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
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { LinearTeamMapping, ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';

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
    const ranked = React.useMemo(
        () => (query ? rankByQuery([...projects], query, (project) => [projectName(project), project.path]) : [...projects]),
        [projects, query],
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
                    projects={projects}
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

const ALL_TEAMS = '__all__';

/**
 * Which Linear team the board lists, and which workspace when more than one
 * is connected: workspaces are few and switched rarely, so they share the menu.
 */
export const SourceBoardTeamPicker: React.FC<{
    teams: readonly LinearTeamMapping[];
    selectedTeamId: string | null;
    onSelectTeam: (teamId: string | null) => void;
    onWorkspaceSwitched: () => void;
}> = ({ teams, selectedTeamId, onSelectTeam, onWorkspaceSwitched }) => {
    const { t } = useI18n();
    const { linear } = useRuntimeAPIs();
    const workspaces = useLinearAuthStore((state) => state.status?.workspaces) ?? [];
    const current = workspaces.find((workspace) => workspace.current) ?? null;
    const [switching, setSwitching] = React.useState(false);
    const workspaceName = (workspace: (typeof workspaces)[number]) => workspace.name?.trim() || workspace.urlKey?.trim() || workspace.id;
    const canSwitch = workspaces.length > 1 && Boolean(current) && Boolean(linear?.authActivate);
    const teamName = teams.find((team) => team.id === selectedTeamId)?.name ?? t('sourceBoard.team.all');

    const activate = async (organizationId: string) => {
        if (!current || organizationId === current.id || switching || !linear?.authActivate) return;
        setSwitching(true);
        try {
            useLinearAuthStore.getState().setStatus(await linear.authActivate(organizationId));
            onWorkspaceSwitched();
            toast.success(t('settings.integrations.linear.toast.workspaceSwitched'));
        } catch (error) {
            toast.error(t('settings.integrations.linear.toast.workspaceSwitchFailed'), { description: error instanceof Error ? error.message : String(error) });
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
                    aria-label={t('sourceBoard.team.label')}
                    disabled={switching}
                    className={cn('min-w-0 w-fit shrink-0 justify-start gap-1 normal-case data-[popup-open]:bg-interactive-hover', TRIGGER_CLASS.toolbar)}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Icon name="linear" className="size-3.5 shrink-0" />
                        {canSwitch && current ? <span className="truncate text-muted-foreground">{workspaceName(current)} /</span> : null}
                        <span className="truncate">{teamName}</span>
                        <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
                    </span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>{t('sourceBoard.team.label')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={selectedTeamId ?? ALL_TEAMS} onValueChange={(value) => onSelectTeam(value === ALL_TEAMS ? null : String(value))}>
                    <DropdownMenuRadioItem value={ALL_TEAMS}>{t('sourceBoard.team.all')}</DropdownMenuRadioItem>
                    {teams.map((team) => <DropdownMenuRadioItem key={team.id} value={team.id}>{team.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                {canSwitch && current ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t('sourceBoard.workspace.label')}</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={current.id} onValueChange={(value) => void activate(String(value))}>
                            {workspaces.map((workspace) => <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>{workspaceName(workspace)}</DropdownMenuRadioItem>)}
                        </DropdownMenuRadioGroup>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
