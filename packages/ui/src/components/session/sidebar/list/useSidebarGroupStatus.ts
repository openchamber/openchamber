import React from 'react';
import type { ChildStoreManager } from '@/sync/child-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { normalizePath } from '../utils';
import type { SessionGroup } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { getSessionFolderScopes } from '../sessions/sessionFolderIdentity';
import type { SessionSidebarGroupStatus } from '../sessionSidebarRowModel';

export const useSidebarGroupStatus = ({
  childStores,
  sections,
  chatGroup,
  canGrantAccess,
}: {
  childStores: ChildStoreManager;
  sections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  canGrantAccess: boolean;
}) => {
  const globalStatus = useGlobalSessionsStore((state) => state.status);
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);
  const groups = React.useMemo(() => [
    ...sections.flatMap((section) => section.groups.map((group) => ({ key: `${section.project.id}:${group.id}`, group }))),
    ...(chatGroup ? [{ key: 'activity:chats', group: chatGroup }] : []),
  ].map(({ key, group }) => ({
    key,
    archived: group.isArchivedBucket === true,
    directories: getSessionFolderScopes(group).map((scope) => normalizePath(scope.directory))
      .filter((directory): directory is string => Boolean(directory)),
  })), [chatGroup, sections]);
  const directories = React.useMemo(() => [...new Set(groups.flatMap((group) => group.directories))], [groups]);
  const bootstrapSnapshot = React.useSyncExternalStore(
    React.useCallback((notify) => directories.length > 0 ? childStores.subscribeBootstrap(notify) : () => undefined, [childStores, directories.length]),
    React.useCallback(() => directories.map((directory) => (
      `${directory}\u0000${childStores.getBootstrapState(directory) ?? ''}\u0000${childStores.getBootstrapFailure(directory) ?? ''}\u0000${childStores.getInitializationState(directory) ?? ''}\u0000${childStores.getInitializationFailure(directory) ?? ''}`
    )).join('\u0001'), [childStores, directories]),
    React.useCallback(() => '', []),
  );
  const groupStatusByKey = React.useMemo(() => {
    // The snapshot invalidates these reads; the directory stores own their state.
    void bootstrapSnapshot;
    const statuses = new Map<string, SessionSidebarGroupStatus>();
    for (const { key, archived, directories: groupDirectories } of groups) {
      const failedDirectory = groupDirectories.find((directory) => (
        childStores.getBootstrapState(directory) === 'failed' || childStores.getInitializationState(directory) === 'failed'
      ));
      if (failedDirectory) {
        const listFailed = childStores.getBootstrapState(failedDirectory) === 'failed';
        const failure = listFailed ? childStores.getBootstrapFailure(failedDirectory) : childStores.getInitializationFailure(failedDirectory);
        statuses.set(key, {
          state: failure === 'os-permission' ? 'permission-denied' : listFailed ? 'load-failed' : 'initialization-failed',
          directory: failedDirectory,
          canGrantAccess: failure === 'os-permission' && canGrantAccess,
        });
      } else {
        // Unopened directories rely on the global list. A previous complete
        // list keeps empty groups ready during background refreshes.
        const complete = hasLoadedGlobalSessions || (!archived && groupDirectories.length > 0
          && groupDirectories.every((directory) => childStores.getBootstrapState(directory) === 'complete'));
        statuses.set(key, {
          state: complete ? 'ready' : globalStatus === 'error' ? 'load-failed' : 'loading',
          // A null directory retries the global list, without initializing a location.
          directory: complete ? groupDirectories[0] ?? null : null,
          canGrantAccess: false,
        });
      }
    }
    return statuses;
  }, [bootstrapSnapshot, canGrantAccess, childStores, groups, globalStatus, hasLoadedGlobalSessions]);
  return { groupStatusByKey, bootstrapSnapshot };
};
