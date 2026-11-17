import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { useParallelComposer } from '../../composer/parallel/useParallelComposer';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerMobileShell } from './useComposerMobileShell';

type Dependencies = Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile' | 'isExpandedInput'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'newSessionDraftOpen' | 'newSessionDraft'>
    & Pick<ReturnType<typeof useComposerInputState>, 'composerText' | 'setMessage' | 'largeTextPasteGesture'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'mobileComposerExpanded'>;

export function useComposerParallelRun({
    isMobile, isBtwActive, newSessionDraftOpen, newSessionDraft, composerText, setMessage,
    largeTextPasteGesture, mobileComposerExpanded, isExpandedInput,
}: Dependencies) {
    const parallel = useParallelComposer({
        enabled: !isMobile && !isBtwActive,
        draftOpen: newSessionDraftOpen && newSessionDraft?.target !== 'chat',
        draftProjectId: newSessionDraft?.selectedProjectId ?? null,
        text: composerText,
        setMessage,
    });

    const parallelProjectId = newSessionDraft?.selectedProjectId ?? null;

    const parallelProject = useProjectsStore(React.useCallback((state) => {
        const project = state.projects.find((entry) => entry.id === (parallelProjectId ?? state.activeProjectId));
        return project ? `${project.id}\n${project.path}` : null;
    }, [parallelProjectId]));

    const parallelProjectRef = React.useMemo(() => {
        if (!parallelProject) return null;
        const [id, path] = parallelProject.split('\n');
        return { id, path };
    }, [parallelProject]);

    const enterParallel = parallel.enter;

    const { isActive: parallelActive, runCount: parallelRunCount, isLaunching: parallelLaunching, launch: launchParallel } = parallel;

    const parallelRun = React.useMemo(() => (parallelActive ? {
        runCount: parallelRunCount,
        launching: parallelLaunching,
        onLaunch: () => { void launchParallel(); },
    } : null), [launchParallel, parallelActive, parallelLaunching, parallelRunCount]);

    React.useLayoutEffect(() => {
        largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, parallel.state?.active, parallel.isActive, newSessionDraftOpen, newSessionDraft?.target, mobileComposerExpanded, isExpandedInput]);

    const handleRunInParallel = React.useCallback(() => {
        // The picker offers it everywhere; a run always starts from a new-session draft.
        if (newSessionDraftOpen && newSessionDraft?.target !== 'chat') enterParallel();
        else openParallelComposer(composerText.get());
    }, [composerText, enterParallel, newSessionDraft?.target, newSessionDraftOpen]);

    return {
        parallel, parallelProjectRef, handleRunInParallel, parallelRun,
    };
}
