import React, { type JSX, type ReactNode } from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { createContentCachedFiles } from '@/contexts/content-cache-owner';

export function RuntimeAPIProvider({ apis, children }: { apis: RuntimeAPIs; children: ReactNode }): JSX.Element {
  const cachedFiles = React.useMemo(() => createContentCachedFiles(apis.files), [apis.files]);
  React.useEffect(() => () => cachedFiles.dispose(), [cachedFiles]);
  const cachedApis = React.useMemo<RuntimeAPIs>(
    () => ({
      ...apis,
      files: cachedFiles.files,
    }),
    [apis, cachedFiles],
  );
  return <RuntimeAPIContext.Provider value={cachedApis}>{children}</RuntimeAPIContext.Provider>;
}
