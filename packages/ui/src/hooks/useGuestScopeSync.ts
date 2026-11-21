import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useProjectContextOwner } from '@/hooks/useProjectContextOwner';
import { setGuestScopePaths, toGuestScopePaths } from '@/lib/guests/folders';
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';

export const useGuestScopeOf = (directory: string | null): readonly string[] => {
  const projectPath = useProjectContextOwner(directory)?.path ?? null;
  const spaceProjectPath = useSpaceProjectDirectory(directory);
  return React.useMemo(() => toGuestScopePaths([directory, projectPath, spaceProjectPath]), [directory, projectPath, spaceProjectPath]);
};

export const useGuestScopeSync = (): void => {
  const paths = useGuestScopeOf(useEffectiveDirectory() ?? null);
  React.useLayoutEffect(() => {
    setGuestScopePaths(paths);
  }, [paths]);
};
