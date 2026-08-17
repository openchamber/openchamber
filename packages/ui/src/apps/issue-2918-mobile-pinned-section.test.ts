/**
 * Regression test for issue #2918: "iPhone session drawer does not show global
 * Pinned section".
 *
 * Reported behavior (OpenChamber 1.18.3, unchanged in 1.18.4 / current main):
 * - Desktop/iPad show pinned sessions lifted to the top of the session list
 *   ("Pinned" cluster above the recency-ordered sessions).
 * - On the iPhone sessions drawer the same sessions are only reachable via
 *   "Show more sessions" — there is no Pinned section and no pinned-first
 *   ordering.
 *
 * Fix (issue #2918): `MobileSessionsSheet` now renders a global "Pinned"
 * section above the project tree (mirroring the desktop sidebar), built from
 * the existing local pin store via `isSessionPinned`. Rows carry a pushpin
 * marker and a pin/unpin swipe action (desktop parity), so pinned sessions
 * are visible and manageable without touching the recency-ordered buckets.
 *
 * Note: pins are persisted per-device in `localStorage`
 * (`oc.sessions.pinned.v2`, keyed by `[runtimeKey, directory, sessionId]`),
 * so a pin created on desktop/iPad does not exist in the iPhone device's
 * store until the user pins on the iPhone itself. The section therefore
 * renders for pins that exist on the current device.
 *
 * The tests below cover the fix at the logic level and assert the structural
 * source observation (rendered Pinned section, pin icon, pin/unpin action).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@opencode-ai/sdk/v2';

import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  resetSessionOrdering,
} from '@/sync/session-ordering';
import { collectSessionSubtreeIds, getSessionParentId, selectPinnedRootSessionIds } from './mobileSessionGrouping';

// --- Constants mirroring packages/ui/src/apps/MobileSessionsSheet.tsx -------
// The sheet pages each project/worktree bucket to the first
// `SESSIONS_PER_BUCKET` roots (renderBucketSessions, `visibleRoots` slice).
const SESSIONS_PER_BUCKET = 7;
const REPO = '/home/user/project';
const DAY_MS = 24 * 60 * 60 * 1000;

const session = (id: string, updated: number, directory = REPO): Session => ({
  id,
  directory,
  title: id,
  version: 'v1',
  projectID: 'proj',
  time: { created: updated - DAY_MS, updated },
} as Session);

const treeSession = (id: string, parentID?: string | null): Session => {
  // SAFETY: this fixture exercises parent-tree logic; other SDK session fields are irrelevant here.
  return {
    id,
    parentID: parentID ?? null,
  } as Session;
};

beforeEach(() => {
  resetSessionOrdering();
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
});

describe('issue #2918: global Pinned section on the mobile sessions sheet', () => {
  test('a pinned session is lifted above much newer sessions (pinned-first ordering)', () => {
    const now = Date.now();
    // The pinned session is OLD (10 days) — recency alone would bury it.
    const pinnedOld = session('pinned-old', now - 10 * DAY_MS);
    // Eight sessions updated seconds ago.
    const recent = Array.from({ length: 8 }, (_, index) => session(`recent-${index}`, now - index * 1000));

    // Pin it in the store, exactly as the pin/unpin swipe action does.
    useSessionPinnedStore.getState().toggle({ directory: REPO, sessionId: 'pinned-old' });
    expect(useSessionPinnedStore.getState().ids.size).toBe(1);

    const ordered = orderSessionsByLifecycleScopes(
      [pinnedOld, ...recent],
      useSessionPinnedStore.getState().ids,
      EMPTY_SESSION_ORDER_RANKS,
    );

    // This is the desktop "Pinned" behavior the issue compares against: the
    // pinned session surfaces at the top of the list.
    expect(ordered[0]?.id).toBe('pinned-old');
  });

  test('the sheet surfaces pinned sessions even when they would fall beyond the first page of a bucket', () => {
    const now = Date.now();
    const pinnedOld = session('pinned-old', now - 10 * DAY_MS);
    const recent = Array.from({ length: 8 }, (_, index) => session(`recent-${index}`, now - index * 1000));

    // Pin the old session on THIS device (the mobile sheet renders pins that
    // exist in the local store).
    useSessionPinnedStore.getState().toggle({ directory: REPO, sessionId: 'pinned-old' });
    const pinnedIds = useSessionPinnedStore.getState().ids;

    // Pre-fix behavior (and cross-device behavior when the pin does not exist
    // in this store): recency-only ordering sinks the 10-day-old session
    // below the first page of its bucket — the reporter's steps 6–7.
    const recencyOnly = orderSessionsByLifecycleScopes(
      [pinnedOld, ...recent],
      new Set(),
      EMPTY_SESSION_ORDER_RANKS,
    );
    expect(recencyOnly.slice(0, SESSIONS_PER_BUCKET).map((entry) => entry.id)).not.toContain('pinned-old');

    // The mobile sheet's pinned section selects pinned root sessions via
    // isSessionPinned and the shared lifecycle ordering.
    const pinnedSection = orderSessionsByLifecycleScopes(
      [pinnedOld, ...recent].filter((entry) => (
        !(entry as Session & { parentID?: string | null }).parentID
        && isSessionPinned(pinnedIds, entry.directory, entry.id)
      )),
      pinnedIds,
      EMPTY_SESSION_ORDER_RANKS,
    );

    expect(pinnedSection.map((entry) => entry.id)).toEqual(['pinned-old']);
  });

  test('excludes a pinned root and its complete child/grandchild subtree from the drawer tree', () => {
    const sessions = [
      treeSession('root'),
      treeSession('child', 'root'),
      treeSession('grandchild', 'child'),
      treeSession('sibling'),
    ];
    const pinnedRootIds = selectPinnedRootSessionIds(sessions, (entry) => entry.id === 'root');

    expect(pinnedRootIds).toEqual(new Set(['root']));
    expect(collectSessionSubtreeIds(sessions, pinnedRootIds)).toEqual(
      new Set(['root', 'child', 'grandchild']),
    );
  });

  test('excludes a pinned root from the drawer tree but keeps it in the project total', () => {
    const now = Date.now();
    const sessions = [
      session('pinned-root', now),
      { ...session('pinned-child', now - 1), parentID: 'pinned-root' },
      session('visible-root', now - 2),
      session('other-project-root', now - 3, '/home/user/other-project'),
    ];
    const pinnedRootIds = selectPinnedRootSessionIds(sessions, (entry) => entry.id === 'pinned-root');
    const pinnedSessionSubtreeIds = collectSessionSubtreeIds(sessions, pinnedRootIds);
    const projectSessions = sessions.filter((entry) => entry.directory === REPO);
    const drawerTreeSessions = projectSessions.filter((entry) => !pinnedSessionSubtreeIds.has(entry.id));
    const projectTotal = projectSessions.filter((entry) => !getSessionParentId(entry)).length;

    expect(drawerTreeSessions.map((entry) => entry.id)).toEqual(['visible-root']);
    expect(projectTotal).toBe(2);
  });

  test('keeps a pinned child under an unpinned root in the existing project tree', () => {
    const sessions = [
      treeSession('root'),
      treeSession('pinned-child', 'root'),
      treeSession('grandchild', 'pinned-child'),
    ];
    const pinnedRootIds = selectPinnedRootSessionIds(sessions, (entry) => entry.id === 'pinned-child');

    expect(pinnedRootIds).toEqual(new Set());
    expect(collectSessionSubtreeIds(sessions, pinnedRootIds)).toEqual(new Set());
  });

  test('terminates safely for malformed parent cycles', () => {
    const sessions = [
      treeSession('cycle-a', 'cycle-b'),
      treeSession('cycle-b', 'cycle-a'),
      treeSession('cycle-child', 'cycle-b'),
    ];

    expect(collectSessionSubtreeIds(sessions, new Set(['cycle-a']))).toEqual(
      new Set(['cycle-a', 'cycle-b', 'cycle-child']),
    );
  });

  test('structural: MobileSessionsSheet renders a Pinned section with pin icon and pin/unpin action', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');

    // A rendered Pinned section above the project tree: the i18n key
    // `directoryTree.section.pinned` ('Pinned') drives the section header and
    // the section is rendered from `pinnedSessions` before `orderedNodes.map`.
    expect(source).toContain("t('directoryTree.section.pinned')");
    expect(source).toContain('pinnedSessions.map');
    const treeRenderIndex = source.indexOf('orderedNodes.map');
    const pinnedSectionIndex = source.indexOf('pinnedSessions.map');
    expect(pinnedSectionIndex).toBeGreaterThanOrEqual(0);
    expect(treeRenderIndex).toBeGreaterThan(pinnedSectionIndex);

    // Pinned selection is derived from the local pin store via isSessionPinned
    // (not a new pinning mechanism).
    expect(source).toContain('isSessionPinned(pinnedSessionIds');
    expect(source).toContain('selectPinnedRootSessionIds');
    expect(source).toContain('collectSessionSubtreeIds');
    expect(source).toContain('pinnedSessionSubtreeIds.has(session.id)');
    expect(source).toContain("variant === 'drawer' && pinnedSessions.length > 0");

    // Desktop-parity affordances: pushpin marker on pinned rows and a
    // pin/unpin swipe action calling the store's existing toggle.
    expect(source).toContain('name="pushpin"');
    expect(source).toContain('togglePinnedSession({ directory');
    expect(source).toContain("t('sessions.sidebar.session.menu.pin')");
    expect(source).toContain("t('sessions.sidebar.session.menu.unpin')");

    // No duplicate rows: pinned roots and all in-snapshot descendants are
    // excluded from the drawer's project tree buckets.
    expect(source).toContain('pinnedSessionSubtreeIds.has(session.id)');

    // Project totals are owned by project resolution, so a pinned root still
    // contributes even though the drawer tree skips its subtree.
    const projectResolutionIndex = source.indexOf('const node = nodes.find');
    const resolvedNodeGuardIndex = source.indexOf('if (!node) continue;', projectResolutionIndex);
    const projectCountIndex = source.indexOf('if (!getSessionParentId(session)) node.totalSessions += 1;');
    const drawerExclusionIndex = source.indexOf(
      "if (variant === 'drawer' && pinnedSessionSubtreeIds.has(session.id)) continue;",
    );
    expect(projectResolutionIndex).toBeGreaterThanOrEqual(0);
    expect(resolvedNodeGuardIndex).toBeGreaterThan(projectResolutionIndex);
    expect(projectCountIndex).toBeGreaterThan(resolvedNodeGuardIndex);
    expect(projectCountIndex).toBeLessThan(drawerExclusionIndex);
    expect(source.match(/node\.totalSessions \+= 1;/g) ?? []).toHaveLength(1);
  });
});
