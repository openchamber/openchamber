import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { GitHubReferenceKind } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { parseChangeRequestReference } from '@/lib/source-control/changeRequestReference';
import { parseIssueReference } from '@/lib/source-control/issueReference';
import { openExternalUrl } from '@/lib/url';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardStore } from '@/stores/useSourceBoardStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const LINEAR_ISSUE_URL = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/;

type TrackerTarget =
    | { source: 'repository'; kind: GitHubReferenceKind }
    | { source: 'linear'; identifier: string };

/** What a link names, as the board and the Tracker show it; null for anything else. */
export const trackerTargetOfUrl = (url: string): TrackerTarget | null => {
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

/** What a Tracker tab is called: `#12`, `!7` for a GitLab merge request, `ENG-7`. */
export const trackerItemLabel = (url: string): string | null => {
    const target = trackerTargetOfUrl(url);
    if (!target) return null;
    if (target.source === 'linear') return target.identifier;
    const changeRequest = parseChangeRequestReference(url);
    const reference = changeRequest?.project ? changeRequest : parseIssueReference(url);
    if (!reference) return null;
    return `${reference === changeRequest && reference.identity?.provider === 'gitlab' ? '!' : '#'}${reference.number}`;
};

// The Tracker tabs a click just opened, by panel and tab, until they first
// show their item. Only those fall back to the browser when their project
// cannot read it; a restored tab, or one that loaded before, says so in place
// instead of opening the browser by itself.
const requestedTabs = new Set<string>();
const requestKey = (panelDirectory: string, tabId: string) => `${normalizeContextPanelDirectoryKey(panelDirectory)}\u0000${tabId}`;
export const wasTrackerItemRequested = (panelDirectory: string, tabId: string): boolean => requestedTabs.has(requestKey(panelDirectory, tabId));
/** The tab has shown its item once: a later failure no longer sends anyone to the browser. */
export const settleTrackerItemRequest = (panelDirectory: string, tabId: string): void => {
    requestedTabs.delete(requestKey(panelDirectory, tabId));
};

/**
 * Shows the issue, PR or Linear issue a link names. On desktop and web it
 * opens as a tab of the Tracker beside the chat on screen, read through the
 * project of `directory` without the app moving there; the phone, which has
 * no side panel, shows it on the issues and PRs board. False, with nothing
 * opened, for anything neither can show here: another kind of link, VS Code,
 * a project that is not open, Linear while it is not connected.
 */
export function useShowTrackerItem() {
    const mobile = useMobileAppActions();
    // Read softly: sidebar rows also render where no runtime is provided, and
    // without one a Linear link simply opens in the browser.
    const linear = React.useContext(RuntimeAPIContext)?.linear;

    return React.useCallback((url: string, directory: string | null | undefined): boolean => {
        if (isVSCodeRuntime()) return false;
        const target = trackerTargetOfUrl(url);
        if (!target) return false;
        if (target.source === 'linear' && (!linear || useLinearAuthStore.getState().status?.connected !== true)) return false;

        const projects = useProjectsStore.getState().projects;
        const worktreesByProject = useSessionUIStore.getState().availableWorktreesByProject;
        const project = target.source === 'repository'
            ? resolveProjectForSessionDirectory(projects, worktreesByProject, directory ?? null)
            : null;
        if (target.source === 'repository' && !project) return false;

        const panelDirectory = mobile ? undefined : resolveEffectiveDirectory();
        if (panelDirectory) {
            const panelProject = resolveProjectForSessionDirectory(projects, worktreesByProject, panelDirectory);
            const tabId = useUIStore.getState().openTrackerItem(panelDirectory, {
                url,
                key: target.source === 'linear' ? `linear:${target.identifier}` : repositoryItemOfUrl(url) ?? url,
                label: trackerItemLabel(url) ?? url,
                // Read through the panel's own folder when the item is its project's.
                targetDirectory: project && project.id !== panelProject?.id ? normalizeProjectPath(project.path) : null,
            });
            if (tabId) requestedTabs.add(requestKey(panelDirectory, tabId));
            return true;
        }

        const board = useSourceBoardStore.getState();
        if (target.source === 'linear') board.focusLinearIssue(target.identifier);
        // The link itself is the search: it finds that one item, in its own repository.
        else if (project) board.focusRepositoryItem(project.id, target.kind, url);
        if (mobile) mobile.openSourceBoard();
        else useUIStore.getState().setSourceBoardOpen(true);
        return true;
    }, [linear, mobile]);
}

/**
 * Opens an issue, PR or Linear issue a session is linked to
 * (`useShowTrackerItem`). Cmd or Ctrl opens the link itself, as links do; so
 * does anything the app cannot show here.
 */
export function useOpenTrackerItem() {
    const showTrackerItem = useShowTrackerItem();

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (event?.metaKey || event?.ctrlKey || !showTrackerItem(url, directory)) void openExternalUrl(url);
    }, [showTrackerItem]);
}
