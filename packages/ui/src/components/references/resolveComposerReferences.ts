
import type { ComposerReference, ComposerReferenceAuthor } from '@/components/chat/composer/composerReferences';
import type {
    ChangeRequestContext,
    Issue,
    IssueComment,
    RepositoryDiscussionReference,
    RepositoryReferenceComment,
    RepositoryReferenceDetail,
    SourceControlAPI,
    SourceControlReadContext,
    TrackerItem,
} from '@/lib/api/types';
import { buildTrackerItemContextText } from '@/lib/trackers/itemContext';
import type { RepositoryUrlResolver } from '@/lib/source-control/repositoryUrlMatcher';

import { referencePickerItemKey, type ReferencePickerSelection } from './referencePickerItems';

export type ReferenceResolveDeps = {
    sourceControl: Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext' | 'referenceDetail'>;
    context: SourceControlReadContext | null;
    readTrackerDetail: (provider: string, itemId: string) => Promise<TrackerItem>;
    trackerName: (provider: string) => string;
};

export type ResolvedReferences = {
    references: ComposerReference[];
    failures: Array<{ key: string; label: string; error: string }>;
};

const buildIssueContextText = (issue: Issue, comments: IssueComment[]) =>
    `Source control issue context (JSON)\n${JSON.stringify({ project: issue.project, issue, comments }, null, 2)}`;

const commentForAgent = (comment: RepositoryReferenceComment) => ({
    author: comment.author?.login ?? null,
    createdAt: comment.createdAt,
    url: comment.url,
    body: comment.body,
});

const buildDiscussionContextText = (discussion: RepositoryDiscussionReference, detail: RepositoryReferenceDetail) => JSON.stringify({
    project: { owner: discussion.sourceRepo.owner, name: discussion.sourceRepo.repo },
    discussion: {
        number: discussion.number,
        title: discussion.title,
        url: discussion.url,
        state: discussion.state,
        category: discussion.category.name,
        answered: discussion.answered,
        upvotes: discussion.upvotes,
        locked: discussion.locked,
        author: discussion.author?.login ?? null,
        createdAt: discussion.createdAt,
        updatedAt: discussion.updatedAt,
        labels: discussion.labels.map((label) => label.name),
        body: discussion.body,
        bodyTruncated: discussion.bodyTruncated,
    },
    commentTotal: detail.commentTotal,
    comments: detail.comments.map((comment) => ({
        ...commentForAgent(comment),
        isAnswer: comment.answer?.chosen ?? null,
        replies: (comment.thread?.replies ?? []).map(commentForAgent),
    })),
}, null, 2);

const buildChangeRequestContextText = (payload: ChangeRequestContext) =>
    `Source control change request context (JSON)\n${JSON.stringify(payload, null, 2)}`;

const selectionLabel = (selection: ReferencePickerSelection): string => (
    selection.source === 'tracker' ? selection.item.identifier : `#${selection.reference.number}`
);

type RepositoryProject = { owner: string; name: string };

async function readTrackerItem(deps: ReferenceResolveDeps, provider: string, itemId: string): Promise<ComposerReference> {
    const item = await deps.readTrackerDetail(provider, itemId);
    const login = item.assignee?.name;
    return {
        kind: 'tracker-item',
        provider,
        identifier: item.identifier,
        title: item.title,
        url: item.url,
        contextText: buildTrackerItemContextText(item, deps.trackerName(provider)),
        author: login ? { login, avatarUrl: item.assignee?.avatarUrl || undefined } : undefined,
    };
}

async function readIssue(
    deps: ReferenceResolveDeps,
    context: SourceControlReadContext,
    project: RepositoryProject,
    number: number,
    author: ComposerReferenceAuthor | undefined,
): Promise<ComposerReference> {
    const [issue, comments] = await Promise.all([
        deps.sourceControl.issueGet(context, number, project),
        deps.sourceControl.issueComments(context, number, project),
    ]);
    if (!issue) throw new Error('Issue not found');
    return {
        kind: 'repository-issue',
        provider: issue.provider,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        contextText: buildIssueContextText(issue, comments),
        author: author ?? (issue.author ? { login: issue.author.username, avatarUrl: issue.author.avatarUrl } : undefined),
    };
}

async function readChangeRequest(
    deps: ReferenceResolveDeps,
    context: SourceControlReadContext,
    project: RepositoryProject,
    number: number,
    includeDiff: boolean,
    author: ComposerReferenceAuthor | undefined,
): Promise<ComposerReference> {
    const changeRequestContext = await deps.sourceControl.changeRequestContext(context, number, {
        includeDiff,
        includeCIDetails: false,
        project,
    });
    const changeRequest = changeRequestContext.changeRequest;
    if (!changeRequest) throw new Error('Pull request not found');
    return {
        kind: 'change-request',
        provider: changeRequest.provider,
        number: changeRequest.number,
        title: changeRequest.title,
        url: changeRequest.url,
        head: changeRequest.head,
        base: changeRequest.base,
        includeDiff,
        contextText: buildChangeRequestContextText(changeRequestContext),
        author: author ?? (changeRequest.author ? { login: changeRequest.author.username, avatarUrl: changeRequest.author.avatarUrl } : undefined),
    };
}

async function resolveOne(selection: ReferencePickerSelection, deps: ReferenceResolveDeps): Promise<ComposerReference> {
    if (selection.source === 'tracker') return readTrackerItem(deps, selection.provider, selection.item.id);

    const { sourceControl, context } = deps;
    if (!context) throw new Error('The repository is not available here');
    const { reference } = selection;
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    const author = reference.author ? { login: reference.author.login, avatarUrl: reference.author.avatarUrl } : undefined;

    if (reference.kind === 'discussion') {
        const result = await sourceControl.referenceDetail(context, {
            owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo, number: reference.number, kind: 'discussion',
        });
        if (!result.connected) throw new Error(`${context.provider} is not connected`);
        if (!result.detail) throw new Error('Discussion not found');
        return {
            kind: 'repository-discussion',
            provider: reference.provider,
            number: reference.number,
            title: reference.title,
            url: reference.url,
            contextText: `Source control discussion context (JSON)\n${buildDiscussionContextText(reference, result.detail)}`,
            author,
        };
    }

    if (reference.kind === 'issue') return readIssue(deps, context, project, reference.number, author);
    return readChangeRequest(deps, context, project, reference.number, selection.includeDiff, author);
}

export type ReferenceLinkTarget =
    | { source: 'repository'; provider: string; instance: string; owner: string; repo: string; kind: 'issue' | 'pull'; number: number }
    | ({ source: 'repository-url' } & RepositoryUrlResolver)
    | { source: 'tracker'; provider: string; identifier: string };

export async function resolveReferenceLink(target: ReferenceLinkTarget, deps: ReferenceResolveDeps): Promise<ComposerReference | null> {
    if (target.source === 'tracker') return readTrackerItem(deps, target.provider, target.identifier);
    const { context } = deps;
    if (!context || context.provider !== target.provider || context.instance !== target.instance) {
        throw new Error('The repository is not available here');
    }
    if (target.source === 'repository-url') {
        const item = await target.resolve();
        if (!item || item.kind !== 'pull') return null;
        return resolveReferenceLink({ source: 'repository', ...item, kind: item.kind }, deps);
    }
    const project = { owner: target.owner, name: target.repo };
    const read = (through: SourceControlReadContext) => (target.kind === 'issue'
        ? readIssue(deps, through, project, target.number, undefined)
        : readChangeRequest(deps, through, project, target.number, false, undefined));
    try {
        return await read(context);
    } catch {
        return read({ ...context, linked: true });
    }
}

export async function resolveComposerReferences(
    selections: readonly ReferencePickerSelection[],
    deps: ReferenceResolveDeps,
): Promise<ResolvedReferences> {
    const outcomes = await Promise.all(selections.map(async (selection) => {
        try {
            return { selection, reference: await resolveOne(selection, deps), error: null };
        } catch (error) {
            return { selection, reference: null, error: error instanceof Error ? error.message : String(error) };
        }
    }));
    const result: ResolvedReferences = { references: [], failures: [] };
    for (const outcome of outcomes) {
        if (outcome.reference) {
            result.references.push(outcome.reference);
        } else {
            result.failures.push({
                key: referencePickerItemKey(outcome.selection),
                label: selectionLabel(outcome.selection),
                error: outcome.error ?? '',
            });
        }
    }
    return result;
}
