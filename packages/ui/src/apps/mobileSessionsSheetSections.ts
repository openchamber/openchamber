import type { Session } from '@/lib/opencode/model';
import {
  attentionZonesInUse,
  type SidebarLayout,
  type SidebarSectionKey,
} from '@/stores/sidebarLayout';

/** Options the phone sheet needs to decide which sections of the layout are drawn. */
type PhoneSectionsVisibility = {
  showChatsSection: boolean;
  showPinnedSection: boolean;
  /** Pinned to the feature flag: the In work zone only exists while it is on. */
  showWorkSection: boolean;
  /** The timeline's Chats join the projects instead of keeping their section. */
  chatsInListProjects: boolean;
};

/**
 * The layout's sections the phone sheet draws now, in the layout's order:
 * the attention zones the layout can fill, Pinned and In work while their
 * toggles show them, Chats while shown and not among the projects, and the
 * project list always. Mirrors the desktop sidebar's `sectionsInUse` filter.
 */
export const phoneSectionsInUse = (
  layout: SidebarLayout,
  visibility: PhoneSectionsVisibility,
): SidebarSectionKey[] => {
  const attentionZones = attentionZonesInUse(layout);
  return layout.sectionOrder.filter((key) => {
    if (key === 'projects') return true;
    if (key === 'chats') return visibility.showChatsSection && !visibility.chatsInListProjects;
    if (key === 'pinned') return visibility.showPinnedSection;
    if (key === 'work') return visibility.showWorkSection;
    return attentionZones.has(key);
  });
};

/**
 * A zone's rows on the phone: the zone's top-level sessions with their whole
 * subtrees, so a collapsed tree row still stands for the requests waiting
 * below it. `sessions` is the sheet's complete active list.
 */
export const expandZoneSessions = (
  sessions: readonly Session[],
  zoneRootIds: ReadonlySet<string>,
  childIdsOf: (sessionId: string) => readonly string[],
): Session[] => {
  if (zoneRootIds.size === 0) return [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const out: Session[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!zoneRootIds.has(session.id) || seen.has(session.id)) continue;
    seen.add(session.id);
    out.push(session);
    for (const childId of childIdsOf(session.id)) {
      const child = byId.get(childId);
      if (child && !seen.has(childId)) {
        seen.add(childId);
        out.push(child);
      }
    }
  }
  return out;
};

/** Top-level ids of `roots` that are not in `excludedIds`, keeping their order. */
export const excludeRoots = (
  roots: readonly Session[],
  excludedIds: ReadonlySet<string>,
): Session[] => (excludedIds.size === 0
  ? [...roots]
  : roots.filter((session) => !excludedIds.has(session.id)));

/**
 * The chats group among the timeline's project groups: the project ids with
 * the chats id at most `index` places in. Clamps to the end of the list.
 */
export const insertChatsGroupIndex = (
  projectIds: readonly string[],
  chatsId: string,
  index: number,
): string[] => {
  const without = projectIds.filter((id) => id !== chatsId);
  const at = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, at), chatsId, ...without.slice(at)];
};
