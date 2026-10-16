import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { GitHubReferenceKind } from '@/lib/api/types';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
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

/** The issue or PR a link names, as one comparable string; null for anything else. */
const repositoryItemOfUrl = (url: string): string | null => {
    const changeRequest = parseChangeRequestReference(url);
    const reference = changeRequest?.project ? changeRequest : parseIssueReference(url);
    if (!reference?.project) return null;
    // GitLab numbers issues and merge requests separately; on GitHub they share one number.
    const kind = reference.identity?.provider === 'gitlab' ? (reference === changeRequest ? '!' : '#') : '#';
    return `${reference.identity?.instance ?? ''}/${reference.project.owner}/${reference.project.name}${kind}${reference.number}`.toLowerCase();
};

/** Whether two links name the same issue or PR, whatever page of it each opens. */
export const isSameRepositoryItemLink = (left: string, right: string): boolean => {
    const item = repositoryItemOfUrl(left);
    return item !== null && item === repositoryItemOfUrl(right);
};

/**
 * How a plain click on a link ended. `unresolved-project` says the link is
 * boardable but `directory` resolved to no open project, so another in-app
 * surface may still show it; `not-showable` says nothing here can.
 */
type BoardAttempt =
    | 'shown'
    | 'unresolved-project'
    | 'not-showable';

function useTryShowOnBoard() {
    const mobile = useMobileAppActions();
    // Read softly: sidebar rows also render where no runtime is provided, and
    // without one a Linear link simply opens in the browser.
    const linear = React.useContext(RuntimeAPIContext)?.linear;

    return React.useCallback((url: string, directory: string | null | undefined): BoardAttempt => {
        if (isVSCodeRuntime()) return 'not-showable';
        const target = boardTargetOfUrl(url);
        if (!target) return 'not-showable';

        const board = useSourceBoardStore.getState();
        if (target.source === 'linear') {
            if (!linear || useLinearAuthStore.getState().status?.connected !== true) return 'not-showable';
            board.focusLinearIssue(target.identifier);
        } else {
            const project = resolveProjectForSessionDirectory(
                useProjectsStore.getState().projects,
                useSessionUIStore.getState().availableWorktreesByProject,
                directory ?? null,
            );
            if (!project) return 'unresolved-project';
            // The link itself is the search: it finds that one item, in its own repository.
            board.focusRepositoryItem(project.id, target.kind, url);
        }
        if (mobile) mobile.openSourceBoard();
        else useUIStore.getState().setSourceBoardOpen(true);
        return 'shown';
    }, [linear, mobile]);
}

/**
 * Whether a plain click can show the issue, PR or Linear issue a link names on
 * the issues and PRs board, in the project of `directory`, selected. False,
 * with nothing opened, for anything the board cannot show here: another kind
 * of link, VS Code, a project that is not open, Linear while it is not
 * connected.
 */
export function useShowOnBoard() {
    const tryShowOnBoard = useTryShowOnBoard();

    return React.useCallback((url: string, directory: string | null | undefined): boolean =>
        tryShowOnBoard(url, directory) === 'shown', [tryShowOnBoard]);
}

/**
 * Opens an issue, PR or Linear issue a session is linked to on the board
 * (`useShowOnBoard`). Cmd or Ctrl opens the link itself, as links do. When the
 * board refuses the link only because `directory` resolved to no open project,
 * the built-in browser panel of that directory shows it instead, where a plain
 * chat link would go; the system browser stays the last resort.
 */
export function useOpenOnBoard() {
    const tryShowOnBoard = useTryShowOnBoard();
    const mobile = useMobileAppActions();

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (event?.metaKey || event?.ctrlKey) {
            void openExternalUrl(url);
            return;
        }
        const attempt = tryShowOnBoard(url, directory);
        if (attempt === 'shown') return;
        // Only the desktop panel can show any site: on the web it is an iframe,
        // which most sites refuse to load in.
        const { openLinksInBrowserPanel, openContextPreview } = useUIStore.getState();
        if (attempt === 'unresolved-project' && openLinksInBrowserPanel && !mobile && isDesktopShell() && directory) {
            openContextPreview(directory, url);
            return;
        }
        void openExternalUrl(url);
    }, [mobile, tryShowOnBoard]);
}
