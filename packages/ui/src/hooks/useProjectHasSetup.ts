import React from 'react';

import { readProjectHasSetup } from '@/lib/spaces/space-setup';

export const useProjectHasSetup = (projectDirectory: string | null): boolean => {
  const [read, setRead] = React.useState<{ directory: string; has: boolean } | null>(null);
  React.useEffect(() => {
    if (!projectDirectory) return;
    let current = true;
    void readProjectHasSetup(projectDirectory).then((has) => { if (current) setRead({ directory: projectDirectory, has }); });
    return () => {
      current = false;
      setRead(null);
    };
  }, [projectDirectory]);
  return read !== null && read.directory === projectDirectory && read.has;
};
