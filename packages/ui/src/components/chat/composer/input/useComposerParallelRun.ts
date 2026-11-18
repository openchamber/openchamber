import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerDraftText } from './useComposerDraftText';
import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { useParallelComposer } from '../../composer/parallel/useParallelComposer';

type Dependencies = {
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'isExpandedInput'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'newSessionDraftOpen' | 'newSessionDraft'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText' | 'setMessage'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteGesture'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileComposerExpanded'>;
};

export function useComposerParallelRun({
    preferences, expansion, sessionScope, draftText, largePasteState, mobileShell,
}: Dependencies) {
    const { isMobile } = preferences;
    const { isExpandedInput } = expansion;
    const { isBtwActive, newSessionDraftOpen, newSessionDraft } = sessionScope;
    const { composerText, setMessage } = draftText;
    const { largeTextPasteGesture } = largePasteState;
    const { mobileComposerExpanded } = mobileShell;

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

    const {
        isActive: parallelActive, runCount: parallelRunCount, isLaunching: parallelLaunching,
        launch: launchParallel,
    } = parallel;

    const parallelRun = React.useMemo(() => (parallelActive ? {
        runCount: parallelRunCount,
        launching: parallelLaunching,
        onLaunch: () => { void launchParallel(); },
    } : null), [launchParallel, parallelActive, parallelLaunching, parallelRunCount]);

    React.useLayoutEffect(() => {
        largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, parallel.state?.active, parallel.isActive, newSessionDraftOpen, newSessionDraft?.target, mobileComposerExpanded, isExpandedInput]);

    const handleRunInParallel = React.useCallback(() => {
        if (newSessionDraftOpen && newSessionDraft?.target !== 'chat') enterParallel();
        else openParallelComposer(composerText.get());
    }, [composerText, enterParallel, newSessionDraft?.target, newSessionDraftOpen]);

    return {
        parallel, parallelProjectRef, handleRunInParallel, parallelRun,
    };
}
