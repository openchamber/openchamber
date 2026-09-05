/**
 * Router module for URL-based navigation in OpenChamber.
 *
 * Provides bidirectional sync between URL query parameters and application state.
 * Works across web, desktop, and VS Code (state-only mode).
 *
 * URL Schema:
 * - `?session=<id>` - Navigate to specific session
 * - `?session=recent` - Navigate to the last active session for this runtime
 * - `?tab=<chat|git|diff|terminal|files>` - Legacy URL name for the active workspace surface
 * - `?settings=<section>` - Open settings to specific section
 * - `?file=<path>` - Diff view with file selected
 *
 * Examples:
 * - `/?session=abc123` - Open session abc123
 * - `/?session=recent` - Open the last session used on this instance
 * - `/?tab=git` - Open the Git surface
 * - `/?settings=providers` - Open settings to providers section
 * - `/?tab=diff&file=src/main.ts` - Open the Diff surface with a file
 */

export type { RouteState } from './types';
export { RECENT_SESSION_TOKEN } from './types';

export { parseRoute, hasRouteParams } from './parseRoute';

export type { AppRouteState } from './serializeRoute';
export {
  updateBrowserURL,
} from './serializeRoute';
