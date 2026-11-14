import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import type { PullRequestSource } from '@/lib/diff/pullRequestDiff';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitStore } from '@/stores/useGitStore';
import type { InlineCommentDraft, InlineCommentSource } from '@/stores/useInlineCommentDraftStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore, type PendingDiffScope } from '@/stores/useUIStore';

/** The parts of a draft that name where its comment was written. */
type CommentSource = Pick<InlineCommentDraft, 'fileLabel' | 'startLine' | 'side' | 'origin'>;

/** Sources whose `fileLabel` names a file on disk. A plan comment names the
 * plan document instead, which may not be saved as a file yet. */
const OPENABLE_SOURCES: readonly InlineCommentSource[] = ['diff', 'file', 'file-quote'];

const scopeOfOrigin = (origin: NonNullable<CommentSource['origin']>): PendingDiffScope => (
    origin.kind === 'change-request' ? 'pr' : origin.kind === 'commit' ? 'commit' : 'branch'
);

const pullRequestSourceOf = (origin: Extract<NonNullable<CommentSource['origin']>, { kind: 'change-request' }>): PullRequestSource => {
    const source: PullRequestSource = { kind: 'pr', number: origin.number };
    const slash = origin.repository?.indexOf('/') ?? -1;
    if (origin.repository && slash > 0) {
        source.sourceRepo = { owner: origin.repository.slice(0, slash), repo: origin.repository.slice(slash + 1) };
    }
    if (origin.revision) source.revision = origin.revision;
    return source;
};

/**
 * Opens where a review comment was written: the file at its line, or the diff
 * of the comparison its lines belong to. A comment on a change request, commit
 * or branch comparison opens that diff, never the file on disk, whose lines
 * are another version and may not hold what the comment quotes.
 */
export function useOpenCommentSource() {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    // The editor's comment threads show files, not comparisons.
    const fileOnly = Boolean(runtime?.runtime.isVSCode);

    /** Whether this surface can show where the comment was written at all. */
    const canOpen = React.useCallback((comment: { source: InlineCommentSource; origin?: unknown }): boolean =>
        OPENABLE_SOURCES.includes(comment.source) && !(fileOnly && comment.origin !== undefined), [fileOnly]);

    const open = React.useCallback((directory: string, draft: CommentSource) => {
        const line = draft.startLine > 0 ? draft.startLine : null;
        const side = draft.side === 'original' ? 'deletions' : 'additions';
        const ui = useUIStore.getState();

        if (!draft.origin) {
            if (runtime?.runtime.isVSCode && runtime.editor) {
                void runtime.editor.openFile(toAbsoluteFilePath(directory, draft.fileLabel), line ?? undefined);
                return;
            }
            const filePath = toAbsoluteFilePath(directory, draft.fileLabel);
            if (line) ui.openContextFileAtLine(directory, filePath, line, 1);
            else ui.openContextFile(directory, filePath);
            mobileActions?.openFiles();
            return;
        }

        const { origin } = draft;
        if (origin.kind === 'change-request') {
            usePullRequestSelectionStore.getState().requestDiff(directory, pullRequestSourceOf(origin));
        } else if (origin.kind === 'branch') {
            // A base is remembered for the branch it was picked on, not the checkout.
            useGitBaseBranchStore.getState().setOverride(directory, origin.headRef, origin.baseRef);
            // The branch scope compares the checkout with its base, so another
            // branch's lines are only there once that branch is checked out.
            const branch = useGitStore.getState().directories.get(directory)?.status?.current ?? null;
            if (branch !== origin.headRef) {
                if (mobileActions) mobileActions.openChanges();
                else ui.openContextDiff(directory, draft.fileLabel, false, 'branch');
                return;
            }
        }

        ui.setPendingCommentLocation({ directory, filePath: draft.fileLabel, line, side, origin });
        if (mobileActions) {
            mobileActions.openChanges();
            return;
        }
        ui.openContextDiff(directory, draft.fileLabel, false, scopeOfOrigin(origin));
    }, [mobileActions, runtime]);

    return React.useMemo(() => ({ open, canOpen }), [canOpen, open]);
}
