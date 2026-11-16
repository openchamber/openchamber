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
import { joinProjectPath } from '@/lib/source-control/projectPath';

type TrackerTarget =
    | { source: 'repository'; kind: RepositoryReferenceKind }
    | { source: 'tracker'; provider: string; identifier: string };

const openBoard = (mobile: ReturnType<typeof useMobileAppActions>) => {
    if (mobile) mobile.openSourceBoard();
    else useUIStore.getState().setSourceBoardOpen(true);
};

export const trackerTargetOfUrl = (url: string, urls: RepositoryUrlMatcher, trackerUrls: TrackerUrlMatcher): TrackerTarget | null => {
    const item = trackerUrls(url);
    if (item) return { source: 'tracker', provider: item.provider, identifier: item.identifier };
    const thread = urls.match(url);
    return thread ? { source: 'repository', kind: thread.kind } : null;
};

const repositoryItemOfUrl = (url: string, urls: RepositoryUrlMatcher): string | null => {
    const item = urls.match(url);
    if (!item) return null;
    const shared = urls.descriptorOf(item.provider).terminology.sharedNumberSpace;
    const marker = !shared && item.kind === 'pull' ? '!' : '#';
    return `${item.instance}/${joinProjectPath(item.owner, item.repo)}${marker}${item.number}`.toLowerCase();
};

export const repositoryUrlOfItemLink = (url: string, urls: RepositoryUrlMatcher): string | null => {
    const item = urls.match(url);
    if (!item) return null;
    return `${new URL(url.trim()).origin}/${joinProjectPath(item.owner, item.repo)}`.toLowerCase();
};

export const isSameRepositoryItemLink = (left: string, right: string, urls: RepositoryUrlMatcher): boolean => {
    const item = repositoryItemOfUrl(left, urls);
    return item !== null && item === repositoryItemOfUrl(right, urls);
};

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

const requestedTabs = new Set<string>();
const requestKey = (panelDirectory: string, tabId: string) => `${normalizeContextPanelDirectoryKey(panelDirectory)}\u0000${tabId}`;
export const wasTrackerItemRequested = (panelDirectory: string, tabId: string): boolean => requestedTabs.has(requestKey(panelDirectory, tabId));
export const settleTrackerItemRequest = (panelDirectory: string, tabId: string): void => {
    requestedTabs.delete(requestKey(panelDirectory, tabId));
};

export function useShowTrackerItem() {
    const mobile = useMobileAppActions();
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
                targetDirectory: project && project.id !== panelProject?.id ? normalizeProjectPath(project.path) : null,
            });
            if (tabId) requestedTabs.add(requestKey(panelDirectory, tabId));
            return true;
        }

        const board = useSourceBoardStore.getState();
        if (target.source === 'tracker') board.focusTrackerItem(target.provider, target.identifier);
        else if (project) board.focusRepositoryItem(project.id, target.kind, url);
        openBoard(mobile);
        return true;
    }, [mobile, trackerUrls, trackers, urls]);
}

export function useOpenProjectOnBoard(): ((projectId: string) => void) | null {
    const mobile = useMobileAppActions();

    const openProjectOnBoard = React.useCallback((projectId: string) => {
        useSourceBoardStore.getState().update({ projectId, tab: 'repository' });
        openBoard(mobile);
    }, [mobile]);
    return isVSCodeRuntime() ? null : openProjectOnBoard;
}

export function useOpenTrackerItem() {
    const showTrackerItem = useShowTrackerItem();

    return React.useCallback((url: string, directory: string | null | undefined, event?: { metaKey: boolean; ctrlKey: boolean }) => {
        if (event?.metaKey || event?.ctrlKey || !showTrackerItem(url, directory)) void openExternalUrl(url);
    }, [showTrackerItem]);
}
