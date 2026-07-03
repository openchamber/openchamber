/**
 * Router module for URL-based navigation in OpenChamber.
 *
 * Provides bidirectional sync between URL query parameters and application state.
 * Works across web, desktop, and VS Code (state-only mode).
 *
 * URL Schema:
 * - `?session=<id>` - Navigate to specific session
 * - `?tab=<chat|git|diff|terminal|files>` - Active main tab
 * - `?settings=<section>` - Open settings to specific section
 * - `?file=<path>` - Diff view with file selected
 *
 * Examples:
 * - `/?session=abc123` - Open session abc123
 * - `/?tab=git` - Open git tab
 * - `/?settings=providers` - Open settings to providers section
 * - `/?tab=diff&file=src/main.ts` - Open diff view with file
 */

export type { RouteState } from './types';


export { parseRoute, hasRouteParams } from './parseRoute';

export type { AppRouteState } from './serializeRoute';
export {
  updateBrowserURL,
} from './serializeRoute';
