import { useCallback, useEffect, useState } from 'react';
import { isDesktopShell, requestDirectoryAccess, startAccessingDirectory, stopAccessingDirectory } from '@/lib/desktop';

export const useFileSystemAccess = () => {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setIsDesktop(isDesktopShell());
  }, []);

  const requestAccess = useCallback(async (directoryPath: string): Promise<{ success: boolean; path?: string; projectId?: string; error?: string }> => {
    if (!isDesktop) {
      return { success: true, path: directoryPath };
    }

    return await requestDirectoryAccess(directoryPath);
  }, [isDesktop]);

  const startAccessing = useCallback(async (directoryPath: string): Promise<{ success: boolean; error?: string }> => {
    if (!isDesktop) {
      return { success: true };
    }

    return await startAccessingDirectory(directoryPath);
  }, [isDesktop]);

  const stopAccessing = useCallback(async (directoryPath: string): Promise<{ success: boolean; error?: string }> => {
    if (!isDesktop) {
      return { success: true };
    }

    return await stopAccessingDirectory(directoryPath);
  }, [isDesktop]);

  return {
    isDesktop,
    requestAccess,
    startAccessing,
    stopAccessing
  };
};
