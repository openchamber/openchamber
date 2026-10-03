import React from 'react';
import type { GitSubmoduleState } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const shortCommit = (commit: string): string => commit.slice(0, 7);

/**
 * A submodule has no file contents to diff, only the commit its parent records
 * and the state of its own checkout. Staged changes compare HEAD with the
 * index; unstaged changes compare the index with the checkout, which is also
 * where uncommitted and untracked work inside the submodule lives.
 */
export const SubmoduleDiffSummary: React.FC<{ state: GitSubmoduleState; staged: boolean }> = ({ state, staged }) => {
    const { t } = useI18n();
    const from = staged ? state.headCommit : state.indexCommit;
    const to = staged ? state.indexCommit : state.worktreeCommit;

    let commitLine: string | null = null;
    if (state.hasConflict) {
        commitLine = t('diffView.submodule.conflict');
    } else if (from && to) {
        commitLine = from === to
            ? t('diffView.submodule.commitUnchanged', { commit: shortCommit(to) })
            : t('diffView.submodule.commitChanged', { from: shortCommit(from), to: shortCommit(to) });
    } else if (to) {
        commitLine = t('diffView.submodule.added', { commit: shortCommit(to) });
    } else if (from) {
        commitLine = staged
            ? t('diffView.submodule.removed', { commit: shortCommit(from) })
            : t('diffView.submodule.notCheckedOut', { commit: shortCommit(from) });
    }

    return (
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background px-3 py-2">
            <div className="typography-ui-label font-semibold text-foreground">{t('diffView.submodule.title')}</div>
            {commitLine ? <div className="typography-meta text-muted-foreground">{commitLine}</div> : null}
            {!staged && state.hasTrackedChanges ? (
                <div className="typography-meta text-muted-foreground">{t('diffView.submodule.trackedChanges')}</div>
            ) : null}
            {!staged && state.hasUntrackedFiles ? (
                <div className="typography-meta text-muted-foreground">{t('diffView.submodule.untrackedFiles')}</div>
            ) : null}
        </div>
    );
};
