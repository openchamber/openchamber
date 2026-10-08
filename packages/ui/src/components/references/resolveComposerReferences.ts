/**
 * Turning what the picker chose into composer chips.
 *
 * The list shows enough to choose; what the agent receives is read fresh at
 * attach time, with the repository's account: a GitHub issue with all its
 * comments, a PR with its comments, review comments, files, checks and
 * optionally its diff, a Linear issue with its comments. Each choice resolves on its own, so one that fails is reported
 * by key while the others still attach.
 */

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import type { ChangeRequestContext, Issue, IssueComment, LinearIssue, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';
import { buildIssueContextText as buildLinearContextText } from '@/lib/linearIssueContext';

import { referencePickerItemKey, type ReferencePickerSelection } from './referencePickerItems';

export type ReferenceResolveDeps = {
    sourceControl: Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext'>;
    /** The GitHub read context of the project the items belong to. */
    context: SourceControlReadContext | null;
    /** A Linear issue with its comments, by Linear id; the preview's cache. */
    readLinearDetail: (issueId: string) => Promise<LinearIssue>;
};

export type ResolvedReferences = {
    references: ComposerReference[];
    failures: Array<{ key: string; label: string; error: string }>;
};

const buildIssueContextText = (issue: Issue, comments: IssueComment[]) =>
    `Source control issue context (JSON)\n${JSON.stringify({ project: issue.project, issue, comments }, null, 2)}`;

const buildChangeRequestContextText = (payload: ChangeRequestContext) =>
    `Source control change request context (JSON)\n${JSON.stringify(payload, null, 2)}`;

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

    const { sourceControl, context } = deps;
    if (!context) throw new Error('GitHub is not available here');
    const { reference } = selection;
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    const author = reference.author ? { login: reference.author.login, avatarUrl: reference.author.avatarUrl } : undefined;

    if (reference.kind === 'issue') {
        const [issue, comments] = await Promise.all([
            sourceControl.issueGet(context, reference.number, project),
            sourceControl.issueComments(context, reference.number, project),
        ]);
        if (!issue) throw new Error('Issue not found');
        return {
            kind: 'repository-issue',
            provider: issue.provider,
            number: issue.number,
            title: issue.title,
            url: issue.url,
            contextText: buildIssueContextText(issue, comments),
            author,
        };
    }

    const changeRequestContext = await sourceControl.changeRequestContext(context, reference.number, {
        includeDiff: selection.includeDiff,
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
        includeDiff: selection.includeDiff,
        contextText: buildChangeRequestContextText(changeRequestContext),
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
