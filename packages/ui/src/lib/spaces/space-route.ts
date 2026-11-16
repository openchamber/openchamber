
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeBootstrapPresent } from '@/lib/vscodeBootstrap';

const SPACE_DIRECTORY = /^\/spaces\/([0-9a-f]{12})(?:\/|$)/;

export const spaceIdOfDirectory = (directory: string | null | undefined): string | null => {
  if (!directory) return null;
  const match = SPACE_DIRECTORY.exec(directory);
  return match ? match[1] : null;
};

export const isSpaceDirectory = (directory: string | null | undefined): boolean => spaceIdOfDirectory(directory) !== null;

const isVSCodeRuntime = (): boolean => isVSCodeBootstrapPresent() || getRegisteredRuntimeAPIs()?.runtime?.isVSCode === true;

export const spaceDirectoryHeaders = (directory: string | null | undefined): Record<string, string> | null => {
  if (!directory || isVSCodeRuntime() || !isSpaceDirectory(directory)) return null;
  return { 'x-opencode-directory': encodeURIComponent(directory), 'x-opencode-directory-encoding': 'uri' };
};

export const spaceRootDirectory = (spaceId: string): string => `/spaces/${spaceId}`;
