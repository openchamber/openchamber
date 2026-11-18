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

type CommentSource = Pick<InlineCommentDraft, 'fileLabel' | 'startLine' | 'side' | 'origin'>;

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

export function useOpenCommentSource() {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const fileOnly = Boolean(runtime?.runtime.isVSCode);

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
            useGitBaseBranchStore.getState().setOverride(directory, origin.headRef, origin.baseRef);
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
