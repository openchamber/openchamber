/**
 * Regression tests for issue #2918: "iPhone session drawer does not show
 * global Pinned section".
 *
 * The phone drawer (`packages/ui/src/apps/MobileSessionsSheet.tsx`,
 * `variant === 'drawer'`) renders a global Pinned section above the project
 * tree for sessions pinned on this device. Pinned roots and their complete
 * in-snapshot subtrees render through that section only; the project tree and
 * the managed Chats bucket skip them so no row appears twice, while project
 * totals still count a pinned root.
 *
 * Pins live in `useSessionPinnedStore` (localStorage, keyed by runtime,
 * directory and session id) — there is no cross-device sync, so the section
 * only ever shows pins created on this device. The iPad `variant="sidebar"`
 * keeps its existing grouped tree and never renders the global section.
 *
 * Most assertions drive the same `mobileSessionGrouping` helpers the sheet
 * calls. A few structural checks cover render-path wiring (drawer gating and
 * the pinned section's position) that would otherwise require mounting the
 * whole drawer against every store and runtime provider.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@opencode-ai/sdk/v2/client';

import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  resetSessionOrdering,
} from '@/sync/session-ordering';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';

import {
  buildMobileProjectNodes,
  collectSessionSubtreeIds,
  getSessionParentId,
  orderPinnedSessionSubtree,
  resolveMobilePinnedOwnership,
  selectPinnedRootSessionIds,
  type ProjectMeta,
} from './mobileSessionGrouping';

const REPO = '/home/user/project';
const OTHER_REPO = '/home/user/other-project';
const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors MobileSessionsSheet's SESSIONS_PER_BUCKET — the page a project or
// worktree bucket shows before "Show more sessions".
const SESSIONS_PER_BUCKET = 7;

// Fixture shape: OpenCode's session payloads carry parentID although the SDK
// base Session type omits it, so keep the fixtures on the wider shape.
type SessionFixture = Session & { parentID?: string | null };

const session = (id: string, updated: number, directory = REPO): SessionFixture => ({
  id,
  slug: id,
  directory,
  title: id,
  version: 'v1',
  projectID: 'proj',
  time: { created: updated - DAY_MS, updated },
});

const childSession = (id: string, parentID: string, updated: number, directory = REPO): SessionFixture => ({
  ...session(id, updated, directory),
  parentID,
});

const project = (id: string, root: string): ProjectMeta => ({
  id,
  label: id,
  path: root,
  isGitRepo: false,
  worktrees: [],
});

const sessionIds = (sessions: readonly Session[]): string[] => sessions.map((entry) => entry.id);
const bucketIds = (nodes: ReturnType<typeof buildMobileProjectNodes>): string[] =>
  nodes.flatMap((node) => node.buckets.flatMap((bucket) => sessionIds(bucket.sessions)));

beforeEach(() => {
  resetSessionOrdering();
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
});

describe('issue #2918: mobile global Pinned section', () => {
  test('pinned-section order keeps pinned roots first with their children attached', () => {
    const now = Date.now();
    const sessions = [
      session('root-old', now - 5 * DAY_MS),
      session('root-new', now),
      childSession('child-new', 'root-new', now - 1_000),
      session('unpinned', now - 500),
    ];
    const ownership = resolveMobilePinnedOwnership(
      sessions,
      (entry) => entry.id === 'root-old' || entry.id === 'root-new',
      true,
    );

    expect([...ownership.rootIds]).toEqual(['root-old', 'root-new']);
    expect(
      sessionIds(orderPinnedSessionSubtree(sessions, ownership.subtreeIds, new Set(), EMPTY_SESSION_ORDER_RANKS)),
    ).toEqual(['root-new', 'child-new', 'root-old']);
  });

  test('a pinned root beyond the first page of its bucket is not buried by pagination', () => {
    const now = Date.now();
    const pinnedOld = session('pinned-old', now - 10 * DAY_MS);
    const recent = Array.from({ length: 8 }, (_, index) => session(`recent-${index}`, now - index * 1_000));
    const sessions = [pinnedOld, ...recent];

    const ownership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'pinned-old', true);
    const treeSessions = sessions.filter((entry) => !ownership.subtreeIds.has(entry.id));

    // Recency-only ordering still sinks the old session below the first page;
    // the Pinned section surfaces it regardless.
    expect(sessionIds(orderSessionsByLifecycleScopes(treeSessions, new Set(), EMPTY_SESSION_ORDER_RANKS)
      .slice(0, SESSIONS_PER_BUCKET))).not.toContain('pinned-old');
    expect(
      sessionIds(orderPinnedSessionSubtree(sessions, ownership.subtreeIds, new Set(), EMPTY_SESSION_ORDER_RANKS)),
    ).toEqual(['pinned-old']);
  });

  test('a pinned root and its complete in-snapshot subtree render once, through Pinned', () => {
    const now = Date.now();
    const sessions = [
      session('root', now),
      childSession('child', 'root', now - 1),
      childSession('grandchild', 'child', now - 2),
      session('sibling', now - 3),
    ];
    const ownership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'root', true);
    expect(ownership.rootIds).toEqual(new Set(['root']));
    expect(ownership.subtreeIds).toEqual(new Set(['root', 'child', 'grandchild']));

    const nodes = buildMobileProjectNodes({
      projects: [project('proj', REPO)],
      activeProjectId: 'proj',
      sessions,
      pinnedSubtreeIds: ownership.subtreeIds,
      hidePinnedSessions: true,
      pinnedSessionIds: new Set(),
      sessionOrderRanks: EMPTY_SESSION_ORDER_RANKS,
    });
    const pinnedRows = orderPinnedSessionSubtree(
      sessions,
      ownership.subtreeIds,
      new Set(),
      EMPTY_SESSION_ORDER_RANKS,
    );

    expect(bucketIds(nodes)).toEqual(['sibling']);
    expect(sessionIds(pinnedRows)).toEqual(['root', 'child', 'grandchild']);
    // Every session renders exactly once: the tree plus Pinned is the snapshot.
    const rendered = [...bucketIds(nodes), ...sessionIds(pinnedRows)];
    expect(rendered).toHaveLength(sessions.length);
    expect(new Set(rendered)).toEqual(new Set(sessionIds(sessions)));
  });

  test('project totals count a pinned root even though its subtree leaves the tree', () => {
    const now = Date.now();
    const sessions = [
      session('pinned-root', now),
      childSession('pinned-child', 'pinned-root', now - 1),
      session('visible-root', now - 2),
    ];
    const ownership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'pinned-root', true);
    const drawerNodes = buildMobileProjectNodes({
      projects: [project('proj', REPO)],
      activeProjectId: null,
      sessions,
      pinnedSubtreeIds: ownership.subtreeIds,
      hidePinnedSessions: true,
      pinnedSessionIds: new Set(),
      sessionOrderRanks: EMPTY_SESSION_ORDER_RANKS,
    });

    expect(drawerNodes[0]?.totalSessions).toBe(2);
    expect(bucketIds(drawerNodes)).toEqual(['visible-root']);

    // The iPad sidebar keeps every session in the grouped tree with the same
    // totals (no global Pinned section there).
    const sidebarNodes = buildMobileProjectNodes({
      projects: [project('proj', REPO)],
      activeProjectId: null,
      sessions,
      pinnedSubtreeIds: new Set(),
      hidePinnedSessions: false,
      pinnedSessionIds: new Set(),
      sessionOrderRanks: EMPTY_SESSION_ORDER_RANKS,
    });
    expect(sidebarNodes[0]?.totalSessions).toBe(2);
    expect(new Set(bucketIds(sidebarNodes))).toEqual(new Set(sessionIds(sessions)));
  });

  test('pinning a child of an unpinned root leaves the project tree untouched', () => {
    const now = Date.now();
    const sessions = [
      session('root', now),
      childSession('pinned-child', 'root', now - 1),
      childSession('grandchild', 'pinned-child', now - 2),
    ];
    const ownership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'pinned-child', true);

    expect(ownership.rootIds).toEqual(new Set());
    expect(ownership.subtreeIds).toEqual(new Set());
    expect(selectPinnedRootSessionIds(sessions, (entry) => entry.id === 'pinned-child')).toEqual(new Set());
  });

  test('a pinned managed Chat root moves to Pinned instead of rendering in Chats twice', () => {
    const now = Date.now();
    const chatDirectory = '/home/user/.config/openchamber/chats/2026-08-31/session-pinned';
    const sessions = [
      session('chat-root', now, chatDirectory),
      childSession('chat-child', 'chat-root', now - 1, chatDirectory),
      session('other-chat', now - 2, '/home/user/.config/openchamber/chats/2026-08-31/session-other'),
    ];
    const ownership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'chat-root', true);
    // Managed chats reach the drawer as their own projection
    // (`partitionSidebarSessions`); the Chats bucket keeps only chats the
    // Pinned section does not own.
    const managedChatSessions = sessions;
    const chatsBucketSessions = managedChatSessions.filter((entry) => !ownership.subtreeIds.has(entry.id));

    expect(sessionIds(orderPinnedSessionSubtree(
      sessions,
      ownership.subtreeIds,
      new Set(),
      EMPTY_SESSION_ORDER_RANKS,
    ))).toEqual(['chat-root', 'chat-child']);
    expect(sessionIds(chatsBucketSessions)).toEqual(['other-chat']);
  });

  test('the sidebar variant never receives drawer pinned ownership', () => {
    const now = Date.now();
    const sessions = [session('pinned-root', now), childSession('pinned-child', 'pinned-root', now - 1)];

    const drawerOwnership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'pinned-root', true);
    const sidebarOwnership = resolveMobilePinnedOwnership(sessions, (entry) => entry.id === 'pinned-root', false);

    expect(drawerOwnership.rootIds.size).toBe(1);
    expect(drawerOwnership.subtreeIds.size).toBe(2);
    expect(sidebarOwnership.rootIds.size).toBe(0);
    expect(sidebarOwnership.subtreeIds.size).toBe(0);
  });

  test('device-local pin store drives the pinned selection', () => {
    const now = Date.now();
    const sessions = [session('pinned-root', now), session('unpinned', now - 1)];
    useSessionPinnedStore.getState().toggle({ directory: REPO, sessionId: 'pinned-root' });
    const pinIds = useSessionPinnedStore.getState().ids;

    const ownership = resolveMobilePinnedOwnership(
      sessions,
      (entry) => isSessionPinned(pinIds, entry.directory, entry.id),
      true,
    );

    expect(ownership.rootIds).toEqual(new Set(['pinned-root']));
    // A pin made for another directory never claims this session.
    expect(isSessionPinned(pinIds, OTHER_REPO, 'pinned-root')).toBe(false);
  });

  test('malformed parent chains terminate instead of looping', () => {
    const now = Date.now();
    const sessions = [
      childSession('cycle-a', 'cycle-b', now),
      childSession('cycle-b', 'cycle-a', now - 1),
      childSession('cycle-child', 'cycle-b', now - 2),
      childSession('self-parent', 'self-parent', now - 3),
    ];

    expect(collectSessionSubtreeIds(sessions, new Set(['cycle-a']))).toEqual(
      new Set(['cycle-a', 'cycle-b', 'cycle-child']),
    );
    expect(collectSessionSubtreeIds(sessions, new Set(['self-parent']))).toEqual(new Set(['self-parent']));
    // A parent id outside the snapshot is a dead end, not a loop.
    expect(collectSessionSubtreeIds(sessions, new Set(['missing-root']))).toEqual(new Set(['missing-root']));
  });

  test('root selection is parent-id based, not directory based', () => {
    const now = Date.now();
    const sessions = [
      session('root-a', now, REPO),
      childSession('child-of-root-a', 'root-a', now - 1, OTHER_REPO),
    ];

    expect(selectPinnedRootSessionIds(sessions, () => true)).toEqual(new Set(['root-a']));
    expect(getSessionParentId(sessions[1]!)).toBe('root-a');
  });

  test('structural: the drawer renders Pinned above the project tree and the sidebar keeps its tree', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');

    const pinnedHeaderIndex = source.indexOf("t('directoryTree.section.pinned')");
    const projectTreeIndex = source.indexOf('{orderedNodes.map((node) => {');
    expect(pinnedHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(projectTreeIndex).toBeGreaterThan(pinnedHeaderIndex);
    expect(source).toContain("{variant === 'drawer' && pinnedRootCount > 0 ? (");
    expect(source).toContain('{ paginateRoots: false },');
    expect(source).toContain('PINNED_SESSION_BUCKET_KEY');
    expect(source).toContain('resolveMobilePinnedOwnership(');
    expect(source).toContain('orderPinnedSessionSubtree(');
    expect(source).toContain('buildMobileProjectNodes(');
  });

  test('structural: pin affordances are drawer-only and use a slot-derived action width', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');

    // Marker + action are wired only for the phone drawer.
    expect(source).toContain("pinned={variant === 'drawer' && isSessionPinned(");
    expect(source).toContain("onTogglePinned={variant === 'drawer'");
    expect(source).toContain("{pinned ? (");
    expect(source).toContain("aria-label={t('sessions.sidebar.session.status.pinned')}");

    // The strip grows by one 48px slot for the pin action; the stale
    // PIN_ACTION_WIDTH subtraction from the old PR is not reintroduced.
    expect(source).toContain('const ROW_ACTION_SLOT_WIDTH = 48;');
    expect(source).toContain('const actionsWidth = ROW_ACTIONS_WIDTH + (onTogglePinned ? ROW_ACTION_SLOT_WIDTH : 0);');
    expect(source).not.toContain('PIN_ACTION_WIDTH');
  });
});
