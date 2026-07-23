import React from 'react';
import type { SessionOwnershipIndex } from '../sessionOwnership';

type Args = {
  ownership: SessionOwnershipIndex;
};

export const useProjectSessionLists = (args: Args) => {
  const {
    ownership,
  } = args;

  const getSessionsForProject = React.useCallback(
    (projectId: string) => {
      return ownership.sessionsByProject.get(projectId) ?? [];
    },
    [ownership],
  );

  const getArchivedSessionsForProject = React.useCallback(
    (projectId: string) => {
      return ownership.archivedSessionsByProject.get(projectId) ?? [];
    },
    [ownership],
  );

  return {
    getSessionsForProject,
    getArchivedSessionsForProject,
  };
};
