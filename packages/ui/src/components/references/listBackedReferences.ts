
import type {
    ChangeRequest,
    ChangeRequestContext,
    ChangeRequestVerdict,
    RepositoryIssueReference,
    RepositoryChangeRequestReference,
    RepositoryReference,
    RepositoryReferenceComment,
    RepositoryReferenceDetail,
    RepositoryReferenceKind,
    RepositoryReferenceFilter,
    Issue,
    IssueComment,
    Project,
    SourceControlAPI,
    SourceControlReadContext,
    SourceControlUser,
} from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import type { RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

import type { ListPage } from './referenceCache';

type ListBackedReads = Pick<SourceControlAPI, 'issuesList' | 'changeRequestsList' | 'issueComments' | 'changeRequestContext' | 'issueGet'>;

const BODY_LIMIT = 20_000;
const NO_LISTED_DISCUSSIONS = 'Discussions are read through the provider\'s own search';

const author = (user: SourceControlUser | null | undefined) => (
    user ? { login: user.username, avatarUrl: user.avatarUrl } : null
);

const sourceRepo = (project: Project) => ({ owner: project.owner, repo: project.name, source: 'origin' });

const body = (text: string | undefined) => {
    const value = text ?? '';
    return { body: value.slice(0, BODY_LIMIT), bodyTruncated: value.length > BODY_LIMIT };
};

const toIssueReference = (issue: Issue): RepositoryIssueReference => ({
    kind: 'issue',
    provider: issue.provider,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    ...body(issue.body),
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    author: author(issue.author),
    labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
    commentCount: 0,
    sourceRepo: sourceRepo(issue.project),
    projectId: issue.project.id,
    state: issue.state === 'open' ? 'open' : 'completed',
});

export const pullReferenceFromChangeRequest = (changeRequest: ChangeRequest): RepositoryChangeRequestReference => {
    const reference: RepositoryChangeRequestReference = {
        kind: 'pull',
        provider: changeRequest.provider,
        number: changeRequest.number,
        title: changeRequest.title,
        url: changeRequest.url,
        ...body(changeRequest.body),
        createdAt: changeRequest.createdAt ?? null,
        updatedAt: changeRequest.updatedAt ?? null,
        author: author(changeRequest.author),
        labels: (changeRequest.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
        commentCount: 0,
        sourceRepo: sourceRepo(changeRequest.project),
        state: changeRequest.state,
        draft: changeRequest.draft,
        head: changeRequest.head,
        base: changeRequest.base,
        headSha: changeRequest.headSha ?? '',
        headRepo: changeRequest.headProject
            ? { owner: changeRequest.headProject.owner, repo: changeRequest.headProject.name, url: changeRequest.headProject.url }
            : null,
        projectId: changeRequest.project.id,
    };
    if (changeRequest.workInProgress !== undefined) reference.workInProgress = changeRequest.workInProgress;
    if (changeRequest.private !== undefined) reference.private = changeRequest.private;
    if (changeRequest.topic) reference.topic = changeRequest.topic;
    if (changeRequest.revisionNumber !== undefined) reference.revisionNumber = changeRequest.revisionNumber;
    return reference;
};

export type ListBackedProvider = {
    descriptor: SourceControlProviderDescriptor;
    urls: RepositoryUrlMatcher;
};

type ItemLookup = { number: number; project?: { owner: string; name: string } };

const NUMBERED = /^(\D{0,4})(\d+)$/u;

const lookupOf = (text: string, kind: RepositoryReferenceKind, context: SourceControlReadContext, provider: ListBackedProvider): ItemLookup | null => {
    const numbered = NUMBERED.exec(text);
    if (numbered) {
        const { changeRequestPrefix, issuePrefix } = provider.descriptor.terminology;
        const prefix = numbered[1];
        const number = Number(numbered[2]);
        const prefixed = prefix === '' || prefix === '#' || prefix === (kind === 'pull' ? changeRequestPrefix : issuePrefix);
        return prefixed && number > 0 ? { number } : null;
    }
    const link = provider.urls.match(text);
    if (!link || link.kind !== kind || link.provider !== context.provider) return null;
    return { number: link.number, project: { owner: link.owner, name: link.repo } };
};

export const fetchListBackedReferencePage = async (
    reads: ListBackedReads,
    context: SourceControlReadContext,
    provider: ListBackedProvider,
    kind: RepositoryReferenceKind,
    filter: RepositoryReferenceFilter,
    text: string,
    cursor: string | null,
): Promise<ListPage<RepositoryReference>> => {
    if (kind === 'discussion') throw new Error(NO_LISTED_DISCUSSIONS);
    const page = cursor ? Number(cursor) : 1;
    const lookup = lookupOf(text, kind, context, provider);
    if (lookup) {
        if (page > 1) return { kind: 'page', items: [], cursor: null, hasMore: false };
        if (kind === 'pull') {
            const found = await reads.changeRequestContext(context, lookup.number, lookup.project ? { project: lookup.project } : undefined);
            return { kind: 'page', items: found.changeRequest ? [pullReferenceFromChangeRequest(found.changeRequest)] : [], cursor: null, hasMore: false };
        }
        const issue = await reads.issueGet(context, lookup.number, lookup.project);
        return { kind: 'page', items: issue ? [toIssueReference(issue)] : [], cursor: null, hasMore: false };
    }
    const options = { page, state: filter.state, people: filter.people, labels: filter.labels, query: text };
    const result = kind === 'issue'
        ? await reads.issuesList(context, options).then((answer) => ({ ...answer, items: answer.items.map(toIssueReference) }))
        : await reads.changeRequestsList(context, options).then((answer) => ({ ...answer, items: answer.items.map(pullReferenceFromChangeRequest) }));
    return { kind: 'page', items: result.items, cursor: result.hasMore ? String(page + 1) : null, hasMore: result.hasMore };
};

const toComment = (comment: MergeRequestNote): RepositoryReferenceComment => {
    const result: RepositoryReferenceComment = {
        id: comment.id,
        author: author(comment.author),
        body: comment.body,
        createdAt: comment.createdAt ?? null,
        url: comment.url,
        path: comment.path ?? null,
        line: comment.line ?? null,
        review: null,
    };
    if (comment.canUpdate !== undefined) result.canUpdate = comment.canUpdate;
    if (comment.canDelete !== undefined) result.canDelete = comment.canDelete;
    return result;
};

const byCreation = (left: RepositoryReferenceComment, right: RepositoryReferenceComment) => (
    (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
);

type MergeRequestNote = IssueComment & { path?: string; line?: number | null };

const threadedComments = (notes: MergeRequestNote[]): RepositoryReferenceComment[] => {
    const comments: RepositoryReferenceComment[] = [];
    const openers = new Map<string, RepositoryReferenceComment>();
    const answers = new Map<string, RepositoryReferenceComment[]>();
    for (const note of notes) {
        const comment = toComment(note);
        const thread = note.thread;
        if (!thread) {
            comments.push(comment);
        } else if (thread.first) {
            if (thread.outdated === true) comment.line = null;
            comment.thread = {
                id: thread.id,
                resolved: thread.resolved,
                outdated: thread.outdated === true,
                canResolve: thread.resolvable && thread.canResolve !== false,
                canReply: thread.canReply !== false,
                replies: [],
            };
            openers.set(thread.id, comment);
            comments.push(comment);
        } else {
            answers.set(thread.id, [...(answers.get(thread.id) ?? []), comment]);
        }
    }
    for (const [id, replies] of answers) {
        const opener = openers.get(id);
        if (opener?.thread) opener.thread.replies = replies.sort(byCreation);
        else comments.push(...replies);
    }
    return comments;
};

const pullDetail = (context: ChangeRequestContext): RepositoryReferenceDetail['pull'] => {
    const commits = (context.commits ?? []).map((commit) => ({
        sha: commit.sha,
        headline: commit.headline,
        author: null,
        authorName: commit.authorName,
        committedAt: commit.committedAt,
        url: commit.url,
    }));
    const pull: NonNullable<RepositoryReferenceDetail['pull']> = {
        reviewDecision: null,
        reviewers: (context.reviewers ?? []).map((user) => (user.avatarUrl
            ? { id: user.id, login: user.username, avatarUrl: user.avatarUrl }
            : { id: user.id, login: user.username })),
        additions: context.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: context.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        changedFiles: context.files.length,
        checks: context.changeRequest?.state === 'open' ? context.ci?.summary ?? null : null,
        commits,
        commitTotal: context.commitsComplete === false ? null : commits.length,
    };
    if (context.stack !== undefined) pull.stack = context.stack;
    if (context.reviews) pull.reviews = context.reviews;
    if (context.canDismissReviews !== undefined) pull.canDismissReviews = context.canDismissReviews;
    if (context.reviewerStates) {
        pull.reviewerStates = context.reviewerStates.map((entry) => (entry.user.avatarUrl
            ? { id: entry.user.id, login: entry.user.username, avatarUrl: entry.user.avatarUrl, state: entry.state }
            : { id: entry.user.id, login: entry.user.username, state: entry.state }));
    }
    if (context.voteLabels) pull.voteLabels = context.voteLabels;
    if (context.submitRequirements) pull.submitRequirements = context.submitRequirements;
    if (context.revisions) pull.revisions = context.revisions;
    return pull;
};

const toVerdict = (verdict: ChangeRequestVerdict): RepositoryReferenceComment => ({
    author: author(verdict.author),
    body: '',
    createdAt: verdict.createdAt,
    url: verdict.url,
    path: null,
    line: null,
    review: verdict.state,
});

export const fetchListBackedReferenceDetail = async (
    reads: ListBackedReads,
    context: SourceControlReadContext,
    reference: RepositoryReference,
    { revision, crossReferences = false }: { revision?: string | undefined; crossReferences?: boolean } = {},
): Promise<RepositoryReferenceDetail> => {
    if (reference.kind === 'discussion') throw new Error(NO_LISTED_DISCUSSIONS);
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind === 'issue') {
        const [issue, notes] = await Promise.all([
            reads.issueGet(context, reference.number, project, crossReferences ? { includeReferences: true } : {}).catch(() => null),
            reads.issueComments(context, reference.number, project),
        ]);
        const comments = notes.map(toComment).sort(byCreation);
        const detail: RepositoryReferenceDetail = { number: reference.number, comments: comments.slice(-50), commentTotal: comments.length, pull: null };
        if (issue?.assignees) detail.assignees = issue.assignees.map((person) => ({ id: person.id, login: person.username, avatarUrl: person.avatarUrl }));
        if (issue && issue.writeAccess !== undefined) detail.writeAccess = issue.writeAccess;
        if (issue?.references && issue.references.length > 0) detail.references = issue.references;
        return detail;
    }
    const options: Parameters<ListBackedReads['changeRequestContext']>[2] = { project, includeDiff: true, includeTimeline: true, includeCIDetails: true };
    if (crossReferences) options.includeReferences = true;
    if (revision) options.revision = revision;
    const changeRequestContext = await reads.changeRequestContext(context, reference.number, options);
    const comments = [
        ...threadedComments([...changeRequestContext.issueComments, ...changeRequestContext.reviewComments]),
        ...(changeRequestContext.verdicts ?? []).map(toVerdict),
    ].sort(byCreation);
    const detail: RepositoryReferenceDetail = {
        number: reference.number,
        comments: comments.slice(-50),
        commentTotal: changeRequestContext.issueComments.length,
        pull: pullDetail(changeRequestContext),
    };
    if (changeRequestContext.branchWriteAccess !== undefined) detail.branchWriteAccess = changeRequestContext.branchWriteAccess;
    if (crossReferences && changeRequestContext.references && changeRequestContext.references.length > 0) detail.references = changeRequestContext.references;
    return detail;
};
