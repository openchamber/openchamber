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

const openBoard = (mobile: ReturnType<typeof useMobileAppActions>) => {
    if (mobile) mobile.openSourceBoard();
    else useUIStore.getState().setSourceBoardOpen(true);
};

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
 * Shows the issue, PR or Linear issue a link names on the issues and PRs
 * board, in the project of `directory`, selected. False, with nothing opened,
 * for anything the board cannot show here: another kind of link, VS Code, a
 * project that is not open, Linear while it is not connected.
 */
export function useShowOnBoard() {
    const mobile = useMobileAppActions();
    // Read softly: sidebar rows also render where no runtime is provided, and
    // without one a Linear link simply opens in the browser.
    const linear = React.useContext(RuntimeAPIContext)?.linear;

    return React.useCallback((url: string, directory: string | null | undefined): boolean => {
        if (isVSCodeRuntime()) return false;
        const target = boardTargetOfUrl(url);
        if (!target) return false;

        const board = useSourceBoardStore.getState();
        if (target.source === 'linear') {
            if (!linear || useLinearAuthStore.getState().status?.connected !== true) return false;
            board.focusLinearIssue(target.identifier);
        } else {
            const project = resolveProjectForSessionDirectory(
                useProjectsStore.getState().projects,
                useSessionUIStore.getState().availableWorktreesByProject,
                directory ?? null,
            );
            if (!project) return false;
            // The link itself is the search: it finds that one item, in its own repository.
            board.focusRepositoryItem(project.id, target.kind, url);
        }
        openBoard(mobile);
        return true;
    }, [linear, mobile]);
}

/**
 * Opens the issues and PRs board on a project's repository; null in VS Code,
 * where there is no board.
 */
export function useOpenProjectOnBoard(): ((projectId: string) => void) | null {
    const mobile = useMobileAppActions();

    const openProjectOnBoard = React.useCallback((projectId: string) => {
        useSourceBoardStore.getState().update({ projectId, tab: 'repository' });
        openBoard(mobile);
    }, [mobile]);
    return isVSCodeRuntime() ? null : openProjectOnBoard;
}

/**
 * Opens an issue, PR or Linear issue a session is linked to on the board
 * (`useShowOnBoard`). Cmd or Ctrl opens the link itself, as links do; so does
 * anything the board cannot show here.
 */
export function useOpenOnBoard() {
    const showOnBoard = useShowOnBoard();

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (event?.metaKey || event?.ctrlKey || !showOnBoard(url, directory)) void openExternalUrl(url);
    }, [showOnBoard]);
}
