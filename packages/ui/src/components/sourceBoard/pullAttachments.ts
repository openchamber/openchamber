import * as React from 'react';

import { toast } from '@/components/ui';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import type { ReferenceCommentItem } from '@/components/references/referenceTimeline';
import { isFailedConclusion } from '@/components/views/git/checkRunState';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PullStack, RepositoryReference, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { resolvePullStackReferences } from '@/components/references/resolvePullStackReferences';
import { usePendingComposerReferences, type ComposerReferenceHandoff } from '@/components/chat/composer/pendingComposerReferences';
import { readComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestLabel } from '@/lib/source-control/providers/terminology';
import type { CIRun } from '@/lib/source-control/types';
import { useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';

/** A failed run as the agent reads it: what failed, where, and what the host said. */
const failedRunText = (run: CIRun): string => {
    const annotations = (run.annotations ?? []).map((annotation) => [
        [annotation.level, annotation.title].filter(Boolean).join(' '),
        annotation.path ? `${annotation.path}${annotation.startLine !== undefined ? `:${annotation.startLine}` : ''}` : null,
        annotation.message,
        annotation.rawDetails,
    ].filter(Boolean).join('\n'));
    const failedSteps = (run.job?.steps ?? [])
        .filter((step) => isFailedConclusion(step.conclusion))
        .map((step) => `step ${step.number ?? '?'}: ${step.name} → ${step.conclusion}`);
    return [
        `check: ${run.job?.workflowName ? `${run.job.workflowName} / ${run.name}` : run.name}`,
        `status: ${run.status ?? 'unknown'} / ${run.conclusion ?? 'unknown'}`,
        run.detailsUrl ? `url: ${run.detailsUrl}` : null,
        run.output?.title ? `title: ${run.output.title}` : null,
        run.output?.summary ? `summary:\n${run.output.summary}` : null,
        failedSteps.length > 0 ? `failed steps:\n${failedSteps.join('\n')}` : null,
        annotations.length > 0 ? `annotations:\n${annotations.join('\n---\n')}` : null,
    ].filter(Boolean).join('\n\n');
};

/**
 * Parts of an issue or PR pinned above the composer, as the PR panel always
 * did: the user decides what to ask and when to send. They go to the session
 * in view, or to a new session's draft.
 */
export function usePullAttachments(reference: RepositoryReference | null) {
    const { t } = useI18n();
    const directory = useEffectiveDirectory();
    const currentDirectory = React.useRef(directory);
    currentDirectory.current = directory;
    const { sourceControl } = useRuntimeAPIs();

    const target = React.useCallback((): InlineCommentDraftTarget | null => {
        const into = readComposerDraftTarget(directory);
        if (!into) {
            toast.error(t('gitView.pr.toast.noActiveSession'), { description: t('gitView.pr.toast.noActiveSessionDescription') });
            return null;
        }
        return into;
    }, [directory, t]);

    // How the chip names what it came from: a change request by its provider's
    // label (`PR #N`, `!N`), an issue by its number (`#N`).
    const descriptor = useSourceControlProvider(reference?.provider);
    const label = !reference
        ? ''
        : reference.kind === 'pull' ? formatChangeRequestLabel(descriptor, reference.number) : referenceNumberLabel(reference, descriptor);
    const provider = reference?.provider;

    const pin = React.useCallback((into: InlineCommentDraftTarget, draft: Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'>) => {
        // The chip names the host only when it is known.
        if (provider) draft.provider = provider;
        useInlineCommentDraftStore.getState().addDraft(into, draft);
    }, [provider]);

    const addComment = React.useCallback((into: InlineCommentDraftTarget, comment: ReferenceCommentItem) => {
        const who = comment.author ? `@${comment.author}` : '';
        const where = comment.location ? ` · ${comment.location}` : '';
        pin(into, {
            source: 'pr-comment',
            fileLabel: `${label} ${who}${where}`.trim(),
            startLine: 0,
            endLine: 0,
            code: comment.body,
            language: 'markdown',
            text: '',
        });
    }, [label, pin]);

    const attachComment = React.useCallback((comment: ReferenceCommentItem) => {
        const into = target();
        if (into) addComment(into, comment);
    }, [addComment, target]);

    const attachComments = React.useCallback((comments: ReferenceCommentItem[]) => {
        const into = target();
        if (!into) return;
        for (const comment of comments) addComment(into, comment);
    }, [addComment, target]);

    const attachFailedChecks = React.useCallback((runs: CIRun[]) => {
        const failed = runs.filter((run) => isFailedConclusion(run.conclusion));
        if (failed.length === 0) {
            toast.message(t('gitView.pr.toast.noFailedChecks'));
            return;
        }
        const into = target();
        if (!into) return;
        for (const run of failed) {
            pin(into, {
                source: 'pr-check',
                fileLabel: `${label} · ${run.name}`,
                startLine: 0,
                endLine: 0,
                code: failedRunText(run),
                language: 'text',
                text: '',
            });
        }
    }, [label, pin, t, target]);

    const attachStack = React.useCallback(async (stack: PullStack, context: SourceControlReadContext) => {
        if (!reference || reference.kind !== 'pull') return;
        const into = target();
        if (!into) return;
        const runtime = getRuntimeKey();
        let runtimeCurrent = true;
        const stopRuntime = subscribeRuntimeEndpointWillChange(() => { runtimeCurrent = false; });
        const initialDraft = useSessionUIStore.getState().newSessionDraft;
        const handoff: ComposerReferenceHandoff | null = into.sessionKey === 'draft'
            ? initialDraft.workDraftId ? { kind: 'draft', workDraftId: initialDraft.workDraftId, runtimeKey: runtime } : null
            : { kind: 'session', sessionId: into.sessionKey };
        const isCurrent = () => {
            const state = useSessionUIStore.getState();
            return runtimeCurrent && getRuntimeKey() === runtime && currentDirectory.current === into.directory && (into.sessionKey === 'draft'
                ? state.newSessionDraft === initialDraft && state.newSessionDraft.open
                : state.currentSessionId === into.sessionKey && !state.newSessionDraft.open);
        };
        const result = await resolvePullStackReferences(stack, reference.sourceRepo, { context, sourceControl, isCurrent }).finally(stopRuntime);
        if (!isCurrent()) {
            toast.message(t('prStacks.attachTargetChanged'));
            return;
        }
        pin(into, { source: 'pr-comment', fileLabel: t('prStacks.title'), startLine: 0, endLine: 0,
            code: result.summary, language: 'text', text: '' });
        if (handoff) usePendingComposerReferences.getState().push(result.references, handoff);
        if (result.failures.length) toast.error(t('prStacks.attachPartial', { members: result.failures.map((failure) => `#${failure.number}`).join(', ') }), {
            description: result.failures.map((failure) => `#${failure.number}: ${failure.error}`).join('\n'),
        });
        else toast.success(t('prStacks.attached'));
    }, [pin, reference, sourceControl, t, target]);

    return { attachComment, attachComments, attachFailedChecks, attachStack };
}
