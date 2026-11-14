import { isPluginContextPanelMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';

/**
 * The tabs of the phone's workspace drawer (and the tablet's workspace panel),
 * in their default order. The user's order and hidden set are stored per
 * device in `useUIStore`; both hold plain ids so a tab added in a later
 * release shows up for everyone, in its default place within a saved order.
 * An id no longer listed (the old `mcp` tab, now a Status section) drops out.
 *
 * Extensions that opt their panel into the phone add one tab each, under the
 * rail's id (`plugin:<id>`). Which ones exist depends on the catalog of the
 * server in use, so every function takes that list; a saved id of an
 * extension that is not available now stays in the stored order (it comes
 * back in its place) and is left out of what the drawer shows.
 */
const BUILT_IN_MOBILE_WORKSPACE_TABS = ['status', 'changes', 'files', 'terminal', 'preview', 'notes'] as const;

export type BuiltInMobileWorkspaceTab = (typeof BUILT_IN_MOBILE_WORKSPACE_TABS)[number];
/**
 * `pages`: the pages other people shared (decision 0018), a tab only while the
 * server holds any. Not one the user orders or hides: it is never stored.
 */
export type MobileWorkspaceTab = OrderedMobileWorkspaceTab | 'pages';

/** The tabs the user orders and hides. */
type OrderedMobileWorkspaceTab = BuiltInMobileWorkspaceTab | PluginContextPanelMode;

const isBuiltInMobileWorkspaceTab = (id: string): id is BuiltInMobileWorkspaceTab =>
  (BUILT_IN_MOBILE_WORKSPACE_TABS as readonly string[]).includes(id);

const NO_EXTENSION_TABS: readonly PluginContextPanelMode[] = [];

/**
 * Every tab in the user's order. A built-in tab the saved order does not name
 * goes before every saved built-in tab that follows it by default, so a new
 * first tab (Status) is first for people who reordered the others too. An
 * extension tab the saved order does not name goes last: it is new to the
 * user.
 */
export const orderMobileWorkspaceTabs = (
  order: readonly string[],
  extensions: readonly PluginContextPanelMode[] = NO_EXTENSION_TABS,
): OrderedMobileWorkspaceTab[] => {
  const known = (id: string): id is OrderedMobileWorkspaceTab => isBuiltInMobileWorkspaceTab(id)
    || (isPluginContextPanelMode(id) && extensions.includes(id));
  const ordered = order.filter(known).filter((id, index, all) => all.indexOf(id) === index);
  BUILT_IN_MOBILE_WORKSPACE_TABS.forEach((id, index) => {
    if (ordered.includes(id)) return;
    const followers = BUILT_IN_MOBILE_WORKSPACE_TABS.slice(index + 1)
      .map((next) => ordered.indexOf(next))
      .filter((position) => position >= 0);
    ordered.splice(followers.length > 0 ? Math.min(...followers) : ordered.length, 0, id);
  });
  for (const id of extensions) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
};

/**
 * The order to store after the user arranged `order`: the tabs it names, and
 * the saved extension tabs it could not name because their extension is not
 * available right now (another server, turned off). Each of those keeps its
 * saved place: right after the tab that preceded it in the saved order, or
 * first when nothing did, so it comes back where the user left it.
 */
export const storedMobileWorkspaceTabOrder = (order: readonly string[], previous: readonly string[]): string[] => {
  const extensionsIn = (ids: readonly string[]) => ids.filter(isPluginContextPanelMode);
  const next: string[] = orderMobileWorkspaceTabs(order, extensionsIn(order));
  const absent = new Set(extensionsIn(previous).filter((id) => !next.includes(id)));
  if (absent.size === 0) return next;
  const following = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of previous) {
    if (next.includes(id)) anchor = id;
    else if (isPluginContextPanelMode(id) && absent.delete(id)) following.set(anchor, [...(following.get(anchor) ?? []), id]);
  }
  return [...(following.get(null) ?? []), ...next.flatMap((id) => [id, ...(following.get(id) ?? [])])];
};

/**
 * The tabs the user keeps, in order. Never empty: a saved set that hides every
 * tab (written by hand or by an older build) shows them all.
 */
export const shownMobileWorkspaceTabs = (
  order: readonly string[],
  hidden: readonly string[],
  extensions: readonly PluginContextPanelMode[] = NO_EXTENSION_TABS,
): OrderedMobileWorkspaceTab[] => {
  const all = orderMobileWorkspaceTabs(order, extensions);
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
  extensions: readonly PluginContextPanelMode[] = NO_EXTENSION_TABS,
): MobileWorkspaceTab[] => {
  const shown = shownMobileWorkspaceTabs(order, hidden, extensions);
  if (shown.some((id) => id === active)) return shown;
  return orderMobileWorkspaceTabs(order, extensions).filter((id) => id === active || shown.includes(id));
};

/**
 * The strip with the shared pages tab in its place: right after Status
 * wherever the user put Status, first when Status is hidden.
 */
export const withReceivedPagesTab = (tabs: readonly MobileWorkspaceTab[]): MobileWorkspaceTab[] => {
  const next: MobileWorkspaceTab[] = tabs.filter((id) => id !== 'pages');
  next.splice(next.indexOf('status') + 1, 0, 'pages');
  return next;
};

/**
 * What a request to open the workspace asks for: a tab, and for Changes
 * optionally the commit scope in the repository `host.openCommit` read the
 * commit from (it already selected the commit under that directory).
 */
export type MobileWorkspaceRequest =
  | { tab: Exclude<MobileWorkspaceTab, 'changes'> }
  | { tab: 'changes'; commit?: { directory: string } };

type MobileWorkspaceOpener = (request: MobileWorkspaceRequest) => void;

let workspaceOpener: MobileWorkspaceOpener | null = null;

/**
 * The mobile shell owns the drawer; code outside React (an extension frame's
 * `openSurface` or `openCommit`, an item handed to an extension panel) asks it
 * to open a tab through here. Returns the disconnect function.
 */
export const connectMobileWorkspaceOpener = (opener: MobileWorkspaceOpener): (() => void) => {
  workspaceOpener = opener;
  return () => {
    if (workspaceOpener === opener) workspaceOpener = null;
  };
};

/** Opens the drawer on the requested tab. False when no mobile shell is mounted. */
export const openMobileWorkspace = (request: MobileWorkspaceRequest): boolean => {
  if (!workspaceOpener) return false;
  workspaceOpener(request);
  return true;
};
