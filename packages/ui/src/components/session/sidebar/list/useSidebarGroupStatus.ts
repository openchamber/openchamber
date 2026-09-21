import React from 'react';
import type { ChildStoreManager } from '@/sync/child-store';
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
  const groups = React.useMemo(() => [
    ...sections.flatMap((section) => section.groups.map((group) => ({ key: `${section.project.id}:${group.id}`, group }))),
    ...(chatGroup ? [{ key: 'activity:chats', group: chatGroup }] : []),
  ].map(({ key, group }) => ({
    key,
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
    for (const { key, directories: groupDirectories } of groups) {
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
        const loading = groupDirectories.some((directory) => {
          const state = childStores.getBootstrapState(directory);
          return state === 'queued' || state === 'running';
        });
        statuses.set(key, { state: loading ? 'loading' : 'ready', directory: groupDirectories[0] ?? null, canGrantAccess: false });
      }
    }
    return statuses;
  }, [bootstrapSnapshot, canGrantAccess, childStores, groups]);
  return { groupStatusByKey, bootstrapSnapshot };
};
