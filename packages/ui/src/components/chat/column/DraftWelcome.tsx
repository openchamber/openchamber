import React from 'react';
import { DraftProjectName } from '@/components/chat/DraftProjectName';
import { requestDraftProjectPicker, useDraftProjectPickerOpen } from '@/hooks/useDraftProjectPicker';
import { DraftPresetChips } from '../DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDraftHeading } from '../useDraftHeading';

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    return label || formatDirectoryName(project.path);
};

const renderDraftTitle = (
    title: string,
    projectLabel: string | null,
    onOpenProjectPicker?: () => void,
): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <DraftProjectName label={projectLabel} onOpenPicker={onOpenProjectPicker} />
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

export const DraftWelcome: React.FC<{ exiting?: boolean }> = ({ exiting = false }) => {
    const draftTarget = useSessionUIStore((state) => state.newSessionDraft.target);
    const selectedProjectId = useSessionUIStore((state) => state.newSessionDraft.selectedProjectId ?? null);
    const projectLabel = useProjectsStore(React.useCallback((state) => {
        if (draftTarget === 'chat') return null;
        const projectId = selectedProjectId ?? state.activeProjectId;
        const project = (projectId
            ? state.projects.find((candidate) => candidate.id === projectId)
            : null) ?? state.projects[0] ?? null;
        return project ? getProjectDisplayLabel(project) : null;
    }, [draftTarget, selectedProjectId]));
    const draftHeading = useDraftHeading(projectLabel);
    const pickerOpen = useDraftProjectPickerOpen();
    const isMobile = useUIStore((state) => state.isMobile);
    const openProjectPicker = isVSCodeRuntime() || exiting ? undefined : requestDraftProjectPicker;
    const wholeHeadingIsTarget = isMobile && Boolean(openProjectPicker);

    return (
        <div className={cn(
            'oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
            exiting && 'pointer-events-none opacity-0',
        )}>
            <h1 className="text-balance text-3xl font-normal tracking-tight text-foreground">
                {wholeHeadingIsTarget ? (
                    <button
                        type="button"
                        onClick={openProjectPicker}
                        aria-haspopup="dialog"
                        aria-expanded={pickerOpen}
                        className="-m-2 inline-block max-w-full cursor-pointer rounded-lg p-2 text-center hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                    >
                        {renderDraftTitle(draftHeading, projectLabel)}
                    </button>
                ) : renderDraftTitle(draftHeading, projectLabel, openProjectPicker)}
            </h1>
            <DraftPresetChips
                onSubmit={(starter) => useInputStore.getState().requestPresetSubmit(starter.submitText, starter.ref.type)}
                className="oc-draft-starters mt-8 max-w-md"
            />
        </div>
    );
};
