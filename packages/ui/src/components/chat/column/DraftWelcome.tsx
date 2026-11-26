import React from 'react';
import { DraftProjectName } from '@/components/chat/DraftProjectName';
import { DraftPresetChips } from '../DraftPresetChips';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { hasRightToLeftText, isolateInsertedText } from '@/lib/i18n/textDirection';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDraftHeading } from '../useDraftHeading';

const PROJECT_PLACEHOLDER = '{project}';

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    return label || formatDirectoryName(project.path);
};

const renderDraftTitle = (template: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return template;
    const projectIndex = template.indexOf(PROJECT_PLACEHOLDER);
    if (projectIndex === -1) return template;

    return (
        <>
            {template.slice(0, projectIndex)}
            <DraftProjectName
                label={isolateInsertedText(projectLabel, hasRightToLeftText(template))}
                trailingText={template.slice(projectIndex + PROJECT_PLACEHOLDER.length)}
            />
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
    const draftHeading = useDraftHeading(projectLabel, 'template');

    return (
        <div className={cn(
            'oc-draft-center flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto px-6 text-center transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
            exiting && 'pointer-events-none opacity-0',
        )}>
            <h1 className="w-full wrap-anywhere text-balance text-3xl font-normal tracking-tight text-foreground">
                {renderDraftTitle(draftHeading, projectLabel)}
            </h1>
            <DraftPresetChips
                onSubmit={(starter) => useInputStore.getState().requestPresetSubmit(starter.submitText, starter.ref.type)}
                className="oc-draft-starters mt-8 max-w-md"
            />
        </div>
    );
};
