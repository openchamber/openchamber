/**
 * Turning what the picker chose into composer chips.
 *
 * The list shows enough to choose; what the agent receives is read fresh at
 * attach time: a GitHub issue with all its comments, a PR with its comments,
 * review comments, files, checks and optionally its diff, a Linear issue with
 * its comments. Each choice resolves on its own, so one that fails is reported
 * by key while the others still attach.
 */

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import type { GitHubAPI, GitHubPullRequestContextResult, LinearIssue } from '@/lib/api/types';
import { buildIssueContextText as buildLinearContextText } from '@/lib/linearStartSession';
import { renderMagicPrompt } from '@/lib/magicPrompts';

import { referencePickerItemKey, type ReferencePickerSelection } from './referencePickerItems';

export type ReferenceResolveDeps = {
    github: GitHubAPI | undefined;
    /** The project the GitHub items belong to. */
    directory: string | null;
    /** A Linear issue with its comments, by Linear id; the preview's cache. */
    readLinearDetail: (issueId: string) => Promise<LinearIssue>;
};

export type ResolvedReferences = {
    references: ComposerReference[];
    failures: Array<{ key: string; label: string; error: string }>;
};

const buildGitHubIssueContextText = (payload: { repo: unknown; issue: unknown; comments: unknown }) =>
    `GitHub issue context (JSON)\n${JSON.stringify(payload, null, 2)}`;

const buildPullRequestContextText = (payload: GitHubPullRequestContextResult) =>
    `GitHub pull request context (JSON)\n${JSON.stringify(payload, null, 2)}`;

const selectionLabel = (selection: ReferencePickerSelection): string => (
    selection.source === 'linear' ? selection.issue.identifier : `#${selection.reference.number}`
);

async function resolveOne(selection: ReferencePickerSelection, deps: ReferenceResolveDeps): Promise<ComposerReference> {
    if (selection.source === 'linear') {
        const issue = await deps.readLinearDetail(selection.issue.id);
        const login = issue.assignee?.displayName || issue.assignee?.name;
        return {
            kind: 'linear-issue',
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            contextText: buildLinearContextText({ issue, comments: issue.comments ?? [] }),
            author: login ? { login, avatarUrl: issue.assignee?.avatarUrl || undefined } : undefined,
        };
    }

    const { github, directory } = deps;
    if (!github || !directory) throw new Error('GitHub is not available here');
    const { reference } = selection;
    const sourceRepo = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo };
    const author = reference.author ? { login: reference.author.login, avatarUrl: reference.author.avatarUrl } : undefined;

    if (reference.kind === 'issue') {
        const [issueRes, commentsRes] = await Promise.all([
            github.issueGet(directory, reference.number, { sourceRepo }),
            github.issueComments(directory, reference.number, { sourceRepo }),
        ]);
        if (issueRes.connected === false || commentsRes.connected === false) throw new Error('GitHub is not connected');
        if (!issueRes.issue) throw new Error('Issue not found');
        return {
            kind: 'github-issue',
            number: issueRes.issue.number,
            title: issueRes.issue.title,
            url: issueRes.issue.url,
            contextText: buildGitHubIssueContextText({ repo: issueRes.repo ?? null, issue: issueRes.issue, comments: commentsRes.comments ?? [] }),
            author,
        };
    }

    const [context, instructionsText] = await Promise.all([
        github.prContext(directory, reference.number, { includeDiff: selection.includeDiff, includeCheckDetails: false, sourceRepo }),
        renderMagicPrompt('github.pr.review.instructions'),
    ]);
    if (context.connected === false) throw new Error('GitHub is not connected');
    if (!context.pr) throw new Error('Pull request not found');
    return {
        kind: 'github-pr',
        number: context.pr.number,
        title: context.pr.title,
        url: context.pr.url,
        head: context.pr.head,
        base: context.pr.base,
        includeDiff: selection.includeDiff,
        instructionsText,
        contextText: buildPullRequestContextText(context),
        author,
    };
}

/** Resolve every choice; successes keep the picker's order. */
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
