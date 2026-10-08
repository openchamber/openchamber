import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { GitHubReferenceKind } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { parseIssueReference } from '@/lib/source-control/issueReference';
import { openExternalUrl } from '@/lib/url';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardStore } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const LINEAR_ISSUE_URL = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/;

type BoardTarget =
    | { source: 'repository'; kind: GitHubReferenceKind }
    | { source: 'linear'; identifier: string };

/** What a link names, as the board lists it; null for anything else. */
export const boardTargetOfUrl = (url: string): BoardTarget | null => {
    const linear = url.match(LINEAR_ISSUE_URL);
    if (linear) return { source: 'linear', identifier: linear[1].toUpperCase() };
    // Only links: a bare `#12` says nothing about which repository it is in.
    if (parseChangeRequestReference(url)?.project) return { source: 'repository', kind: 'pull' };
    if (parseIssueReference(url)?.project) return { source: 'repository', kind: 'issue' };
    return null;
};

/**
 * Opens an issue, PR or Linear issue a session is linked to on the issues and
 * PRs board, in the session's project, selected. Cmd or Ctrl opens the link
 * itself, as links do; so does anything the board cannot show here (VS Code,
 * a project the session is not in, Linear while it is not connected).
 */
export function useOpenOnBoard() {
    const mobile = useMobileAppActions();
    // Read softly: sidebar rows also render where no runtime is provided, and
    // without one a Linear link simply opens in the browser.
    const linear = React.useContext(RuntimeAPIContext)?.linear;

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        const openLink = () => { void openExternalUrl(url); };
        if (event?.metaKey || event?.ctrlKey || isVSCodeRuntime()) return openLink();
        const target = boardTargetOfUrl(url);
        if (!target) return openLink();

        const board = useSourceBoardStore.getState();
        if (target.source === 'linear') {
            if (!linear || useLinearAuthStore.getState().status?.connected !== true) return openLink();
            board.focusLinearIssue(target.identifier);
        } else {
            const project = resolveProjectForSessionDirectory(
                useProjectsStore.getState().projects,
                useSessionUIStore.getState().availableWorktreesByProject,
                directory ?? null,
            );
            if (!project) return openLink();
            // The link itself is the search: it finds that one item, in its own repository.
            board.focusRepositoryItem(project.id, target.kind, url);
        }
        if (mobile) mobile.openSourceBoard();
        else useUIStore.getState().setSourceBoardOpen(true);
    }, [linear, mobile]);
}
