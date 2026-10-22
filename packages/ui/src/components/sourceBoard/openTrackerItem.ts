import * as React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { RepositoryReferenceKind } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { useRepositoryUrlMatcher, type RepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { openExternalUrl } from '@/lib/url';
import { useTrackerUrlMatcher, type TrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { isTrackerConnected, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardStore } from '@/stores/useSourceBoardStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

type TrackerTarget =
    | { source: 'repository'; kind: RepositoryReferenceKind }
    | { source: 'tracker'; provider: string; identifier: string };

const openBoard = (mobile: ReturnType<typeof useMobileAppActions>) => {
    if (mobile) mobile.openSourceBoard();
    else useUIStore.getState().setSourceBoardOpen(true);
};

/**
 * What a link names, as the board and the Tracker show it; null for anything
 * else. A served tracker's item link (its descriptor's URL patterns) comes
 * first, then a repository item.
 */
export const trackerTargetOfUrl = (url: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): TrackerTarget | null => {
    const item = trackerUrls(url);
    if (item) return { source: 'tracker', provider: item.provider, identifier: item.identifier };
    // Only links: a bare `#12` says nothing about which repository it is in.
    const thread = urls.match(url);
    return thread ? { source: 'repository', kind: thread.kind } : null;
};

/**
 * The issue or PR a link names, as one comparable string; null for anything
 * else. Where a provider numbers issues and change requests apart (#1 and !1)
 * the kind is part of it; where they share one number it is not, so an
 * issue link that the host redirects to its pull request names the same item.
 */
const repositoryItemOfUrl = (url: string, urls: RepositoryUrlMatcher): string | null => {
    const item = urls.match(url);
    if (!item) return null;
    const shared = urls.descriptorOf(item.provider).terminology.sharedNumberSpace;
    const marker = !shared && item.kind === 'pull' ? '!' : '#';
    return `${item.instance}/${item.owner}/${item.repo}${marker}${item.number}`.toLowerCase();
};

/** The repository a link to an issue or PR points into, as `https://host/owner/name` in lowercase; null for anything else. */
export const repositoryUrlOfItemLink = (url: string, urls: RepositoryUrlMatcher): string | null => {
    const item = urls.match(url);
    if (!item) return null;
    return `${new URL(url.trim()).origin}/${item.owner}/${item.repo}`.toLowerCase();
};

/** Whether two links name the same issue or PR, whatever page of it each opens. */
export const isSameRepositoryItemLink = (left: string, right: string, urls: RepositoryUrlMatcher): boolean => {
    const item = repositoryItemOfUrl(left, urls);
    return item !== null && item === repositoryItemOfUrl(right, urls);
};

/** What a Tracker tab is called: `#12`, `!7` for a merge request, `ENG-7`. */
export const trackerItemLabel = (url: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): string | null => {
    const tracked = trackerUrls(url);
    if (tracked) return tracked.identifier;
    const item = urls.match(url);
    if (!item) return null;
    const descriptor = urls.descriptorOf(item.provider);
    return item.kind === 'pull'
        ? formatChangeRequestReference(descriptor, item.number)
        : `${descriptor.terminology.issuePrefix}${item.number}`;
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
 * Shows the issue, PR or tracker item a link names. On desktop and web it
 * opens as a tab of the Tracker beside the chat on screen, read through the
 * project of `directory` without the app moving there; the phone, which has
 * no side panel, shows it on the issues and PRs board. False, with nothing
 * opened, for anything neither can show here: another kind of link, VS Code,
 * a project that is not open, a tracker while it is not connected.
 */
export function useShowTrackerItem() {
    const mobile = useMobileAppActions();
    // Read softly: sidebar rows also render where no runtime is provided, and
    // without one a tracker link simply opens in the browser.
    const trackers = React.useContext(RuntimeAPIContext)?.trackers;
    const urls = useRepositoryUrlMatcher();
    const trackerUrls = useTrackerUrlMatcher();

    return React.useCallback((url: string, directory: string | null | undefined): boolean => {
        if (isVSCodeRuntime()) return false;
        const target = trackerTargetOfUrl(url, urls, trackerUrls);
        if (!target) return false;
        if (target.source === 'tracker' && (!trackers || !isTrackerConnected(useTrackerAuthStore.getState().entries[target.provider]))) return false;

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
                key: target.source === 'tracker' ? `${target.provider}:${target.identifier}` : repositoryItemOfUrl(url, urls) ?? url,
                label: trackerItemLabel(url, urls, trackerUrls) ?? url,
                // Read through the panel's own folder when the item is its project's.
                targetDirectory: project && project.id !== panelProject?.id ? normalizeProjectPath(project.path) : null,
            });
            if (tabId) requestedTabs.add(requestKey(panelDirectory, tabId));
            return true;
        }

        const board = useSourceBoardStore.getState();
        if (target.source === 'tracker') board.focusTrackerItem(target.provider, target.identifier);
        // The link itself is the search: it finds that one item, in its own repository.
        else if (project) board.focusRepositoryItem(project.id, target.kind, url);
        openBoard(mobile);
        return true;
    }, [mobile, trackerUrls, trackers, urls]);
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
 * Opens an issue, PR or tracker item a session is linked to
 * (`useShowTrackerItem`). Cmd or Ctrl opens the link itself, as links do; so
 * does anything the app cannot show here.
 */
export function useOpenTrackerItem() {
    const showTrackerItem = useShowTrackerItem();

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (event?.metaKey || event?.ctrlKey || !showTrackerItem(url, directory)) void openExternalUrl(url);
    }, [showTrackerItem]);
}
