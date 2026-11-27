import * as React from 'react';

import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { toast } from '@/components/ui';
import { readComposerDraftTarget } from '@/hooks/useComposerAddress';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { reviewThreadCapability } from '@/lib/source-control/reviewThreads';
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
    headSha: string | undefined;
    directory: string;
    writeAccess?: boolean;
};

export type ReviewSubmission = { body?: string } & (
    | { verdict: ReviewVerdict; votes?: never }
    | { votes: Record<string, number>; verdict?: never; publishDrafts?: boolean }
);

export type ChangeRequestReview = {
    state: ChangeRequestReviewState | null;
    readFailed: boolean;
    fileComments: boolean;
    canWrite: boolean;
    addComment: (position: ReviewCommentPosition, body: string) => Promise<boolean>;
    updateComment: (commentId: string, body: string) => Promise<boolean>;
    deleteComment: (commentId: string) => Promise<boolean>;
    reply?: (threadId: string, body: string) => Promise<boolean>;
    setResolved?: (threadId: string, resolved: boolean) => Promise<boolean>;
    attachThread: (thread: ReviewThread) => void;
    submit: (submission: ReviewSubmission) => Promise<boolean>;
    discard: () => Promise<boolean>;
};

const reviewKeyOf = (context: SourceControlReadContext, owner: string, name: string, number: number) => (
    JSON.stringify([context.provider, context.instance, context.accountId, context.repositoryId, owner, name, number])
);

const writeDenials = new Set<string>();
const writeDenialListeners = new Set<() => void>();
const subscribeWriteDenials = (listener: () => void) => {
    writeDenialListeners.add(listener);
    return () => { writeDenialListeners.delete(listener); };
};

export const rememberReviewWriteAccess = (
    context: SourceControlReadContext,
    project: { owner: string; name: string },
    number: number,
    writeAccess: boolean | undefined,
) => {
    if (writeAccess === undefined) return;
    const key = reviewKeyOf(context, project.owner, project.name, number);
    if (writeDenials.has(key) === !writeAccess) return;
    if (writeAccess) writeDenials.delete(key);
    else writeDenials.add(key);
    for (const listener of writeDenialListeners) listener();
};

const threadForAgent = (thread: ReviewThread): string => thread.comments
    .map((comment) => `@${comment.author?.login ?? 'unknown'}: ${comment.body}`)
    .join('\n\n');

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

    const reviewKey = available && context && owner !== undefined && name && number
        ? reviewKeyOf(context, owner, name, number)
        : null;
    const explicitAccess = target?.writeAccess;
    const denied = React.useSyncExternalStore(
        subscribeWriteDenials,
        () => explicitAccess === false || (explicitAccess === undefined && reviewKey !== null && writeDenials.has(reviewKey)),
    );
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
                setState((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
            }
            setReadFailed(!result.connected);
        } catch {
            if (isCurrent()) setReadFailed(true);
        }
    }, [context, name, number, owner, reviewKey, sourceControl]);
    const readLatest = React.useRef(read);
    React.useEffect(() => { readLatest.current = read; }, [read]);

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
        const threads = reviewThreadCapability(descriptor);
        const canWrite = !denied;
        const canSubmit = descriptor.features.reviews;
        return {
            state,
            readFailed,
            fileComments: descriptor.features.reviewDraftFileComments,
            canWrite,
            addComment: (position, body) => (canWrite ? write(
                () => sourceControl.changeRequestReviewComment({ ...mutation(), target: reviewed, ...position, body }),
                t('review.toast.addFailed', { reference: label }),
            ) : Promise.resolve(false)),
            updateComment: (commentId, body) => (canWrite ? write(
                () => sourceControl.changeRequestReviewCommentUpdate({ ...mutation(), target: existing, commentId, body }),
                t('review.toast.updateFailed', { reference: label }),
            ) : Promise.resolve(false)),
            deleteComment: (commentId) => (canWrite ? write(
                () => sourceControl.changeRequestReviewCommentDelete({ ...mutation(), target: existing, commentId }),
                t('review.toast.deleteFailed', { reference: label }),
            ) : Promise.resolve(false)),
            reply: threads.reply ? (threadId, body) => write(
                () => sourceControl.changeRequestReplyToThread({ ...mutation(), target: existing, threadId, body }),
                t('sourceBoard.thread.toast.replyFailed', { reference: label }),
            ) : undefined,
            setResolved: threads.resolve ? (threadId, resolved) => write(
                () => sourceControl.changeRequestResolveThread({ ...mutation(), target: existing, threadId, resolved }),
                t(resolved ? 'sourceBoard.thread.toast.resolveFailed' : 'sourceBoard.thread.toast.unresolveFailed', { reference: label }),
            ) : undefined,
            attachThread: (thread) => {
                const into = readComposerDraftTarget(directory);
                if (!into) {
                    toast.error(t('gitView.pr.toast.noActiveSession'), { description: t('gitView.pr.toast.noActiveSessionDescription') });
                    return;
                }
                const lines = thread.line === null ? '' : `:${thread.line}`;
                const draftId = useInlineCommentDraftStore.getState().addDraft(into, {
                    source: 'pr-comment',
                    fileLabel: `${label} · ${thread.path}${lines}`,
                    startLine: 0,
                    endLine: 0,
                    code: threadForAgent(thread),
                    language: 'markdown',
                    text: '',
                    provider: target?.provider,
                });
                if (!draftId) toast.error(t('inlineComment.toast.noRoom'));
            },
            submit: (submission) => (canSubmit ? write(
                async () => {
                    await sourceControl.changeRequestReview({ ...mutation(), target: reviewed, ...submission });
                    toast.success(t('review.toast.submitted', { reference: label }));
                },
                t('review.toast.submitFailed', { reference: label }),
            ) : Promise.resolve(false)),
            discard: () => (canWrite ? write(
                () => sourceControl.changeRequestReviewDiscard({ ...mutation(), target: existing }),
                t('review.toast.discardFailed', { reference: label }),
            ) : Promise.resolve(false)),
        };
    }, [context, denied, descriptor, directory, headSha, name, number, owner, read, readFailed, reviewKey, sourceControl, state, t, target?.provider]);
}

type ComparisonReview = { review: ChangeRequestReview | null; provider: SourceControlProvider | null };

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
        reviewable && readContext && provider && directory && owner !== undefined && name && number
            ? { context: readContext, provider, project: { owner, name }, number, headSha, directory }
            : null
    ), [directory, headSha, name, number, owner, provider, readContext, reviewable]);
    return { review: useChangeRequestReview(target), provider };
}

export const ChangeRequestReviewContext = React.createContext<ChangeRequestReview | null>(null);

export const useChangeRequestReviewContext = (): ChangeRequestReview | null => React.useContext(ChangeRequestReviewContext);

export const reviewDraftCount = (review: ChangeRequestReview | null): number => review?.state?.draft?.comments.length ?? 0;
