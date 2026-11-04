import * as React from 'react';

import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { toast } from '@/components/ui';
import { readComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { formatChangeRequestLabel } from '@/lib/source-control/providers/terminology';
import type {
    ChangeRequest,
    ChangeRequestReviewState,
    ReviewCommentPosition,
    ReviewThread,
    ReviewVerdict,
    SourceControlProvider,
    SourceControlReadContext,
} from '@/lib/source-control/types';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';

export type ChangeRequestReviewTarget = {
    context: SourceControlReadContext;
    provider: SourceControlProvider;
    project: { owner: string; name: string };
    number: number;
    /** The commit the diff on screen was read at. */
    headSha: string | undefined;
    directory: string;
};

export type ReviewSubmission = { body?: string } & (
    | { verdict: ReviewVerdict; votes?: never }
    | { votes: Record<string, number>; verdict?: never; publishDrafts?: boolean }
);

/** One change request's review, shared by every file its diff draws. */
export type ChangeRequestReview = {
    state: ChangeRequestReviewState | null;
    /** The last read failed: `state` is older than the host, or absent. */
    readFailed: boolean;
    fileComments: boolean;
    addComment: (position: ReviewCommentPosition, body: string) => Promise<boolean>;
    updateComment: (commentId: string, body: string) => Promise<boolean>;
    deleteComment: (commentId: string) => Promise<boolean>;
    reply: (threadId: string, body: string) => Promise<boolean>;
    setResolved: (threadId: string, resolved: boolean) => Promise<boolean>;
    attachThread: (thread: ReviewThread) => void;
    submit: (submission: ReviewSubmission) => Promise<boolean>;
    discard: () => Promise<boolean>;
};

const threadForAgent = (thread: ReviewThread): string => thread.comments
    .map((comment) => `@${comment.author?.login ?? 'unknown'}: ${comment.body}`)
    .join('\n\n');

/**
 * Reads the review of the change request a diff shows and writes to it. Null
 * outside such a diff and on a host without review drafts, so a surface that
 * shares the comment field draws only what it always did. Every write reads
 * the review again, a refused one too, since a refusal most often means it
 * changed since the last read. An agent's draft written through `gh` appears
 * when its turn ends or the window comes back.
 */
export function useChangeRequestReview(target: ChangeRequestReviewTarget | null): ChangeRequestReview | null {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const descriptor = useSourceControlProvider(target?.provider);
    const available = Boolean(target && descriptor.features.reviewDrafts);
    const context = target?.context ?? null;
    const owner = target?.project.owner;
    const name = target?.project.name;
    const number = target?.number;
    const headSha = target?.headSha;
    const directory = target?.directory ?? null;
    const [state, setState] = React.useState<ChangeRequestReviewState | null>(null);
    const [readFailed, setReadFailed] = React.useState(false);

    // What the reads are for. A read or a write's follow-up started for another
    // change request answers nobody, so it can neither fill this one nor
    // invalidate this one's own read.
    const reviewKey = available && context && owner !== undefined && name && number
        ? JSON.stringify([context.provider, context.instance, context.accountId, context.repositoryId, owner, name, number])
        : null;
    const currentKey = React.useRef<string | null>(null);
    const readSequence = React.useRef(0);
    const read = React.useCallback(async () => {
        if (!reviewKey || !context || owner === undefined || !name || !number || currentKey.current !== reviewKey) return;
        readSequence.current += 1;
        const sequence = readSequence.current;
        const isCurrent = () => sequence === readSequence.current && currentKey.current === reviewKey;
        try {
            const result = await sourceControl.changeRequestReviewState(context, { owner, repo: name, number });
            if (!isCurrent()) return;
            if (result.connected) {
                const { viewerIsAuthor, headSha: liveHead, draft, threads, truncated } = result;
                const next = { viewerIsAuthor, headSha: liveHead, draft, threads, truncated };
                // A read that found nothing new leaves every card where it is.
                setState((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
            }
            setReadFailed(!result.connected);
        } catch {
            if (isCurrent()) setReadFailed(true);
        }
    }, [context, name, number, owner, reviewKey, sourceControl]);
    const readLatest = React.useRef(read);
    React.useEffect(() => { readLatest.current = read; }, [read]);

    // Another change request starts from nothing: the last one's draft is not this one's.
    React.useEffect(() => {
        currentKey.current = reviewKey;
        setState(null);
        setReadFailed(false);
        void readLatest.current();
        return () => { currentKey.current = null; };
    }, [reviewKey]);

    React.useEffect(() => {
        if (!reviewKey) return undefined;
        const onReturn = () => {
            if (document.visibilityState === 'visible') void read();
        };
        window.addEventListener('focus', onReturn);
        document.addEventListener('visibilitychange', onReturn);
        const releaseEvents = subscribeOpenchamberEvents((event) => {
            if (event.type === 'source-control-activity' && event.directory === directory) void read();
        });
        return () => {
            window.removeEventListener('focus', onReturn);
            document.removeEventListener('visibilitychange', onReturn);
            releaseEvents();
        };
    }, [directory, read, reviewKey]);

    return React.useMemo(() => {
        if (!reviewKey || !context || owner === undefined || !name || !number) return null;
        const project = { owner, name };
        const existing = { project, number };
        const reviewed = { ...existing, headSha: headSha ?? state?.headSha };
        const label = formatChangeRequestLabel(descriptor, number);
        const write = async <T,>(perform: () => Promise<T>, failure: string): Promise<boolean> => {
            try {
                await perform();
                await read();
                return true;
            } catch (error) {
                toast.error(failure, { description: error instanceof Error ? error.message : String(error) });
                await read();
                return false;
            }
        };
        const mutation = () => ({ ...context, idempotencyKey: newMutationKey() });
        return {
            state,
            readFailed,
            fileComments: descriptor.features.reviewDraftFileComments,
            addComment: (position, body) => write(
                () => sourceControl.changeRequestReviewComment({ ...mutation(), target: reviewed, ...position, body }),
                t('review.toast.addFailed', { reference: label }),
            ),
            updateComment: (commentId, body) => write(
                () => sourceControl.changeRequestReviewCommentUpdate({ ...mutation(), target: existing, commentId, body }),
                t('review.toast.updateFailed', { reference: label }),
            ),
            deleteComment: (commentId) => write(
                () => sourceControl.changeRequestReviewCommentDelete({ ...mutation(), target: existing, commentId }),
                t('review.toast.deleteFailed', { reference: label }),
            ),
            reply: (threadId, body) => write(
                () => sourceControl.changeRequestReplyToThread({ ...mutation(), target: existing, threadId, body }),
                t('sourceBoard.thread.toast.replyFailed', { reference: label }),
            ),
            setResolved: (threadId, resolved) => write(
                () => sourceControl.changeRequestResolveThread({ ...mutation(), target: existing, threadId, resolved }),
                t(resolved ? 'sourceBoard.thread.toast.resolveFailed' : 'sourceBoard.thread.toast.unresolveFailed', { reference: label }),
            ),
            attachThread: (thread) => {
                const into = readComposerDraftTarget(directory);
                if (!into) {
                    toast.error(t('gitView.pr.toast.noActiveSession'), { description: t('gitView.pr.toast.noActiveSessionDescription') });
                    return;
                }
                const lines = thread.line === null ? '' : `:${thread.line}`;
                useInlineCommentDraftStore.getState().addDraft(into, {
                    source: 'pr-comment',
                    fileLabel: `${label} · ${thread.path}${lines}`,
                    startLine: 0,
                    endLine: 0,
                    code: threadForAgent(thread),
                    language: 'markdown',
                    text: '',
                    provider: target?.provider,
                });
            },
            submit: (submission) => write(
                async () => {
                    await sourceControl.changeRequestReview({ ...mutation(), target: reviewed, ...submission });
                    toast.success(t('review.toast.submitted', { reference: label }));
                },
                t('review.toast.submitFailed', { reference: label }),
            ),
            discard: () => write(
                () => sourceControl.changeRequestReviewDiscard({ ...mutation(), target: existing }),
                t('review.toast.discardFailed', { reference: label }),
            ),
        };
    }, [context, descriptor, directory, headSha, name, number, owner, read, readFailed, reviewKey, sourceControl, state, t, target?.provider]);
}

type ComparisonReview = { review: ChangeRequestReview | null; provider: SourceControlProvider | null };

/** The review of the open change request a comparison surface (Changes, Walkthrough, mobile Changes) shows. An earlier revision, and a change request outside the project, read only. */
export function useComparisonReview(
    comparison: {
        selectedSource: PullRequestSource | null;
        prs: ChangeRequest[];
        readContext: SourceControlReadContext | null;
        provider: SourceControlProvider | null;
    },
    directory: string | null | undefined,
    enabled: boolean,
): ComparisonReview {
    const { selectedSource: source, prs, readContext, provider } = comparison;
    const record = source ? prs.find((pr) => pr.number === source.number) : undefined;
    const owner = source?.sourceRepo?.owner ?? record?.project.owner;
    const name = source?.sourceRepo?.repo ?? record?.project.name;
    const number = source?.number;
    const reviewable = enabled && !source?.revision && !source?.linked && (!record || record.state === 'open');
    const headSha = record?.headSha;
    const target = React.useMemo<ChangeRequestReviewTarget | null>(() => (
        // A top-level project on a path-style host has an empty owner.
        reviewable && readContext && provider && directory && owner !== undefined && name && number
            ? { context: readContext, provider, project: { owner, name }, number, headSha, directory }
            : null
    ), [directory, headSha, name, number, owner, provider, readContext, reviewable]);
    return { review: useChangeRequestReview(target), provider };
}

export const ChangeRequestReviewContext = React.createContext<ChangeRequestReview | null>(null);

export const useChangeRequestReviewContext = (): ChangeRequestReview | null => React.useContext(ChangeRequestReviewContext);

/** Unpublished comments in the viewer's review. */
export const reviewDraftCount = (review: ChangeRequestReview | null): number => review?.state?.draft?.comments.length ?? 0;
