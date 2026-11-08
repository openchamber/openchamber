/**
 * The tabs of the phone's workspace drawer (and the tablet's workspace panel),
 * in their default order. The user's order and hidden set are stored per
 * device in `useUIStore`; both hold plain ids so a tab added in a later
 * release shows up for everyone, in its default place within a saved order.
 * An id no longer listed (the old `mcp` tab, now a Status section) drops out.
 *
 * An installed extension's own panel is a `guest:<id>` tab, the same slot the
 * desktop rail gives it. The catalog decides which guest tabs exist; a saved
 * order keeps their ids so a reinstall comes back where the user put it.
 */
const MOBILE_WORKSPACE_TABS = ['status', 'changes', 'files', 'terminal', 'notes'] as const;

export type BuiltInMobileWorkspaceTab = (typeof MOBILE_WORKSPACE_TABS)[number];
type GuestMobileWorkspaceTab = `guest:${string}`;
export type MobileWorkspaceTab = BuiltInMobileWorkspaceTab | GuestMobileWorkspaceTab;

const GUEST_TAB_PREFIX = 'guest:';
/** Guest ids are the plugin mode ids (`lib/surfaces/modes.ts`). */
const GUEST_ID = /^[a-z][a-z0-9-]*$/;

export const isBuiltInMobileWorkspaceTab = (id: string): id is BuiltInMobileWorkspaceTab =>
  (MOBILE_WORKSPACE_TABS as readonly string[]).includes(id);

export const guestMobileWorkspaceTabId = (guestId: string): GuestMobileWorkspaceTab => `${GUEST_TAB_PREFIX}${guestId}`;

export const isGuestMobileWorkspaceTab = (id: string): id is GuestMobileWorkspaceTab =>
  id.startsWith(GUEST_TAB_PREFIX) && GUEST_ID.test(id.slice(GUEST_TAB_PREFIX.length));

export const isMobileWorkspaceTab = (id: string): id is MobileWorkspaceTab =>
  isBuiltInMobileWorkspaceTab(id) || isGuestMobileWorkspaceTab(id);

/**
 * The stored order, cleaned: only ids this build understands, first occurrence
 * wins. Guest ids stay even when that extension is not installed, so a paused
 * or reinstalled extension keeps its place.
 */
export const sanitizeMobileWorkspaceTabOrder = (order: readonly string[]): string[] => {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of order) {
    if (!isMobileWorkspaceTab(id) || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }
  return cleaned;
};

/** The guest tabs the catalog offers, cleaned and de-duplicated. */
const guestTabIdsOf = (guestTabIds: readonly string[]): GuestMobileWorkspaceTab[] => {
  const seen = new Set<string>();
  const cleaned: GuestMobileWorkspaceTab[] = [];
  for (const id of guestTabIds) {
    if (!isGuestMobileWorkspaceTab(id) || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }
  return cleaned;
};

/**
 * Every tab in the user's order. A tab the saved order does not name goes
 * before every saved tab that follows it by default, so a new first tab
 * (Status) is first for people who reordered the others too. Saved orders are
 * always complete, so in practice only a tab a release added is missing.
 * Extension tabs the saved order does not name go last.
 */
export const orderMobileWorkspaceTabs = (
  order: readonly string[],
  guestTabIds: readonly string[] = [],
): MobileWorkspaceTab[] => {
  const guests = guestTabIdsOf(guestTabIds);
  const ordered = sanitizeMobileWorkspaceTabOrder(order).filter(
    (id): id is MobileWorkspaceTab => isBuiltInMobileWorkspaceTab(id) || (isGuestMobileWorkspaceTab(id) && guests.includes(id)),
  );
  MOBILE_WORKSPACE_TABS.forEach((id, index) => {
    if (ordered.includes(id)) return;
    const followers = MOBILE_WORKSPACE_TABS.slice(index + 1)
      .map((next) => ordered.indexOf(next))
      .filter((position) => position >= 0);
    ordered.splice(followers.length > 0 ? Math.min(...followers) : ordered.length, 0, id);
  });
  for (const id of guests) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
};

/**
 * The tabs the user keeps, in order. Never empty: a saved set that hides every
 * tab (written by hand or by an older build) shows them all.
 */
export const shownMobileWorkspaceTabs = (
  order: readonly string[],
  hidden: readonly string[],
  guestTabIds: readonly string[] = [],
): MobileWorkspaceTab[] => {
  const all = orderMobileWorkspaceTabs(order, guestTabIds);
  const shown = all.filter((id) => !hidden.includes(id));
  return shown.length > 0 ? shown : all;
};

/**
 * The tabs the strip offers right now: the ones the user keeps, plus the open
 * tab while something opened it although it is hidden (a changed file tapped
 * in the chat opens Changes either way). It leaves the strip once the user
 * switches away.
 */
export const stripMobileWorkspaceTabs = (
  order: readonly string[],
  hidden: readonly string[],
  active: MobileWorkspaceTab,
  guestTabIds: readonly string[] = [],
): MobileWorkspaceTab[] => {
  const shown = shownMobileWorkspaceTabs(order, hidden, guestTabIds);
  if (shown.includes(active)) return shown;
  return orderMobileWorkspaceTabs(order, guestTabIds).filter((id) => id === active || shown.includes(id));
};
