/**
 * Issues and change requests of a provider without a reference search
 * (`features.referenceSearch` off) in the picker's item shape.
 *
 * The picker lists one project's issues and change requests whichever host it
 * lives on. Such a provider's pages come from the provider-neutral list reads
 * (page-numbered) and its preview from the neutral comment and context reads,
 * mapped onto the rows and preview every repository item uses. GitLab lists
 * this way; so does any provider the UI has no code for.
 */

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
    // The neutral issue carries no close reason; closed reads as done.
    state: issue.state === 'open' ? 'open' : 'completed',
});

/**
 * A change request as the preview reads it. The neutral lists and any host's
 * branch status carry this shape; the comment count is not in it, and labels
 * only where the host sends them.
 */
export const pullReferenceFromChangeRequest = (changeRequest: ChangeRequest): RepositoryChangeRequestReference => ({
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
});

/** The provider a list-backed page is read from, and how links are read. */
export type ListBackedProvider = {
    descriptor: SourceControlProviderDescriptor;
    urls: RepositoryUrlMatcher;
};

type ItemLookup = { number: number; project?: { owner: string; name: string } };

const NUMBERED = /^(\D{0,4})(\d+)$/u;

/**
 * The one item a search names: a number, bare or with `#` or the kind's own
 * prefix (`!12`), or a link to an item of this kind on the context's
 * provider. Anything else, a link to another provider among it, is searched.
 */
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

/** One page of a project's issues or change requests, filtered like a searched page; the cursor is the next page number. */
export const fetchListBackedReferencePage = async (
    reads: ListBackedReads,
    context: SourceControlReadContext,
    provider: ListBackedProvider,
    kind: RepositoryReferenceKind,
    filter: RepositoryReferenceFilter,
    text: string,
    cursor: string | null,
): Promise<ListPage<RepositoryReference>> => {
    const page = cursor ? Number(cursor) : 1;
    // A number or a link names one item, as on a searched page: it is read,
    // not searched for (list searches match titles and descriptions only).
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
    // An empty query is not sent.
    const options = { page, state: filter.state, people: filter.people, query: text };
    const result = kind === 'issue'
        ? await reads.issuesList(context, options).then((answer) => ({ ...answer, items: answer.items.map(toIssueReference) }))
        : await reads.changeRequestsList(context, options).then((answer) => ({ ...answer, items: answer.items.map(pullReferenceFromChangeRequest) }));
    return { kind: 'page', items: result.items, cursor: result.hasMore ? String(page + 1) : null, hasMore: result.hasMore };
};

const toComment = (comment: MergeRequestNote): RepositoryReferenceComment => ({
    author: author(comment.author),
    body: comment.body,
    createdAt: comment.createdAt ?? null,
    url: comment.url,
    path: comment.path ?? null,
    line: comment.line ?? null,
    review: null,
});

const byCreation = (left: RepositoryReferenceComment, right: RepositoryReferenceComment) => (
    (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
);

type MergeRequestNote = IssueComment & { path?: string; line?: number | null };

/**
 * Notes as the preview's thread: a note that opens a thread carries
 * the notes that answer it, which leave the list. An answer whose opener is
 * not there stays in the list on its own.
 */
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
            // When the host did not say what this account may do, the buttons
            // stay and the host's own refusal explains a write it does not allow.
            comment.thread = {
                id: thread.id,
                resolved: thread.resolved,
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
    // Absent when the chain could not be read, which is not the same as in none.
    if (context.stack !== undefined) pull.stack = context.stack;
    return pull;
};

/** A reviewer's approval or change request, placed among the comments like a searched provider's. */
const toVerdict = (verdict: ChangeRequestVerdict): RepositoryReferenceComment => ({
    author: author(verdict.author),
    body: '',
    createdAt: verdict.createdAt,
    url: verdict.url,
    path: null,
    line: null,
    review: verdict.state,
});

/** Comments, and a change request's size and pipeline, for the previewed item. */
export const fetchListBackedReferenceDetail = async (
    reads: ListBackedReads,
    context: SourceControlReadContext,
    reference: RepositoryReference,
): Promise<RepositoryReferenceDetail> => {
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind === 'issue') {
        const comments = (await reads.issueComments(context, reference.number, project)).map(toComment).sort(byCreation);
        return { number: reference.number, comments: comments.slice(-50), commentTotal: comments.length, pull: null };
    }
    // The size comes from the changed files, which the neutral read only lists with their
    // diffs; the pipeline's totals from its jobs, read only with CI details.
    const changeRequestContext = await reads.changeRequestContext(context, reference.number, { project, includeDiff: true, includeTimeline: true, includeCIDetails: true });
    const comments = [
        ...threadedComments([...changeRequestContext.issueComments, ...changeRequestContext.reviewComments]),
        ...(changeRequestContext.verdicts ?? []).map(toVerdict),
    ].sort(byCreation);
    return {
        number: reference.number,
        comments: comments.slice(-50),
        commentTotal: changeRequestContext.issueComments.length,
        pull: pullDetail(changeRequestContext),
    };
};
