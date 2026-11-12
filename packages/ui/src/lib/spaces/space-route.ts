// How the UI addresses an isolated space: by naming the directory. A space's code lives at
// `/spaces/<id>/<folder>` on both sides, and the server sends a request that names such a
// directory in its query or its `x-opencode-directory` header to that space; the host's own
// routes never see it. So the directory alone says where a request goes, and the dispatcher
// never guesses. See "Dispatcher" in packages/web/server/lib/spaces/DOCUMENTATION.md.
//
// VS Code never gets the feature (decision 16): there no directory header is added for a
// space, so a request for such a directory reaches the extension host as any other and fails
// as any other.

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeBootstrapPresent } from '@/lib/vscodeBootstrap';

const SPACE_DIRECTORY = /^\/spaces\/([0-9a-f]{12})(?:\/|$)/;

/** The space that owns a directory, or null for a host directory. */
export const spaceIdOfDirectory = (directory: string | null | undefined): string | null => {
  if (!directory) return null;
  const match = SPACE_DIRECTORY.exec(directory);
  return match ? match[1] : null;
};

/** Whether a directory lies inside an isolated space. */
export const isSpaceDirectory = (directory: string | null | undefined): boolean => spaceIdOfDirectory(directory) !== null;

// The same answer as `isVSCodeRuntime` in `lib/desktop.ts`, read from the two light sources it
// reads, so this seam under `runtimeFetch` pulls no runtime-switch module in behind it.
const isVSCodeRuntime = (): boolean => isVSCodeBootstrapPresent() || getRegisteredRuntimeAPIs()?.runtime?.isVSCode === true;

/**
 * The headers that send a request to the space owning `directory`: its directory header,
 * URI-encoded and marked so, which every reader on the server decodes the same way. Null for a
 * host directory, and in VS Code.
 */
export const spaceDirectoryHeaders = (directory: string | null | undefined): Record<string, string> | null => {
  if (!directory || isVSCodeRuntime() || !isSpaceDirectory(directory)) return null;
  return { 'x-opencode-directory': encodeURIComponent(directory), 'x-opencode-directory-encoding': 'uri' };
};

/** The root of a space, `/spaces/<id>`: the directory a socket of that space names. */
export const spaceRootDirectory = (spaceId: string): string => `/spaces/${spaceId}`;
