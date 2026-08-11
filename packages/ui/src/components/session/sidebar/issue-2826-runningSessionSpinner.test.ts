/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/2826
 *
 * A working session must spin; a finished-but-unread one must stay a static
 * dot. Rendering these rows in bun test is not practical — `SessionNodeItem`
 * alone needs about 40 props plus store, sync, drag-and-drop and base-ui
 * providers — so this follows the source-level guard pattern in
 * layout/__tests__/issue-2815-sessionChatIframesMountAllTabs.test.ts. The
 * shared aggregate marker is covered by rendering in
 * collapsedActivityIndicator.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SITES = [
  {
    name: 'sidebar session row',
    path: join(__dirname, 'SessionNodeItem.tsx'),
    busyBranch: 'const statusMarkerContent = isStreaming',
  },
  {
    name: 'collapsed project aggregate',
    path: join(__dirname, '..', 'SessionSidebar.tsx'),
    busyBranch: 'if (hasBusySession) {',
  },
  {
    name: 'mobile sessions sheet row',
    path: join(__dirname, '..', '..', '..', 'apps', 'MobileSessionsSheet.tsx'),
    busyBranch: '{isStreaming ? (',
  },
  {
    name: 'mobile session switcher row',
    path: join(__dirname, '..', '..', '..', 'apps', 'MobileSessionSwitcher.tsx'),
    busyBranch: '{isStreaming ? (',
  },
] as const;

/** The branch body, long enough to hold the marker and its sibling. */
const branchBody = (source: string, anchor: string): string => {
  const index = source.indexOf(anchor);
  expect(index).toBeGreaterThan(-1);
  return source.slice(index, index + 600);
};

describe('running-session marker (issue #2826 regression guard)', () => {
  for (const site of SITES) {
    test(`${site.name} spins while the session runs and keeps a static unread dot`, () => {
      const body = branchBody(readFileSync(site.path, 'utf-8'), site.busyBranch);

      expect(body).toContain('loader-4');
      expect(body).toContain('animate-spin');
      // A dot chosen by the running state is the reported regression: it makes
      // running and unread differ by colour alone.
      expect(body).not.toContain("isStreaming ? 'bg-primary'");
      expect(body).not.toContain("hasBusySession ? 'bg-primary'");
    });
  }
});
