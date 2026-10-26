import { useCallback, useEffect, useState } from 'react';
import {
  canRequestNativeDirectoryAccess,
  isDesktopShell,
  requestDirectoryAccess,
  startAccessingDirectory,
  stopAccessingDirectory,
} from '@/lib/desktop';

export const useFileSystemAccess = () => {
  const [isDesktop, setIsDesktop] = useState(false);
  const [canRequestAccess, setCanRequestAccess] = useState(false);

  useEffect(() => {
    setIsDesktop(isDesktopShell());
    setCanRequestAccess(canRequestNativeDirectoryAccess());
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
    canRequestAccess,
    requestAccess,
    startAccessing,
    stopAccessing
  };
};
