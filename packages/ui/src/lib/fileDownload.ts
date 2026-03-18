import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';

export const canTriggerFileDownload = (): boolean => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  if (isVSCodeRuntime()) {
    return false;
  }

  if (!isDesktopShell()) {
    return true;
  }

  return isDesktopLocalOriginActive();
};

export const triggerFileDownload = (filePath: string, fileName: string): boolean => {
  if (!canTriggerFileDownload()) {
    return false;
  }

  const downloadUrl = `/api/fs/raw?path=${encodeURIComponent(filePath)}`;

  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  return true;
};
