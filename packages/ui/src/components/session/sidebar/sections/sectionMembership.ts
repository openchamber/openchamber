import {
  hasSidebarSectionConditions,
  matchesSidebarSectionFilter,
  type BuiltinSidebarSectionId,
  type CustomSidebarSection,
  type SidebarSectionEntry,
  type SidebarWorkFacts,
} from '@/lib/sidebarSections';
import type { SidebarWorkRef } from '../works/sidebarWorks';

export type VisibleSidebarSection =
  | { kind: 'pages' }
  | { kind: 'chats' }
  | { kind: 'pinned'; claims: boolean }
  | { kind: 'work'; claims: boolean }
  | { kind: 'custom'; section: CustomSidebarSection; preview: boolean }
  | { kind: 'projects' };

export const resolveVisibleSidebarSections = ({
  sections,
  hiddenSections,
  draft,
  draftIsNew,
  show,
  keepWorkInPlace,
  keepPinnedInPlace,
  customSections,
  pages,
}: {
  sections: readonly SidebarSectionEntry[];
  hiddenSections: readonly string[];
  draft: CustomSidebarSection | null;
  draftIsNew: boolean;
  show: Readonly<Record<Exclude<BuiltinSidebarSectionId, 'projects' | 'pages'>, boolean>>;
  keepWorkInPlace: boolean;
  keepPinnedInPlace: boolean;
  customSections: boolean;
  pages: boolean;
}): VisibleSidebarSection[] => {
  const entries: SidebarSectionEntry[] = [...sections];
  if (customSections && draft && draftIsNew) {
    const pinnedIndex = entries.findIndex((entry) => entry.kind === 'builtin' && entry.id === 'pinned');
    entries.splice(pinnedIndex >= 0 ? pinnedIndex + 1 : 0, 0, draft);
  }
  const hidden = new Set(hiddenSections);
  return entries.flatMap((entry): VisibleSidebarSection[] => {
    if (entry.kind === 'builtin') {
      switch (entry.id) {
        case 'pages': return pages && !hidden.has('pages') ? [{ kind: 'pages' }] : [];
        case 'chats': return show.chats ? [{ kind: 'chats' }] : [];
        case 'pinned': return show.pinned ? [{ kind: 'pinned', claims: !keepPinnedInPlace }] : [];
        case 'work': return show.work ? [{ kind: 'work', claims: !keepWorkInPlace }] : [];
        case 'projects': return [{ kind: 'projects' }];
      }
    }
    if (!customSections) return [];
    if (draft && draft.id === entry.id) return [{ kind: 'custom', section: draft, preview: true }];
    return hidden.has(entry.id) ? [] : [{ kind: 'custom', section: entry, preview: false }];
  });
};

type SidebarSectionMembership = {
  pinned: readonly SidebarWorkRef[];
  work: readonly SidebarWorkRef[];
  custom: ReadonlyMap<string, readonly SidebarWorkRef[]>;
  projectGroups: ReadonlyMap<string, readonly string[]>;
  claimedKeys: ReadonlySet<string>;
  claimedProjectIds: ReadonlySet<string>;
};

export const resolveSidebarSectionMembership = ({
  sections,
  pinned,
  work,
  all,
  projectIds,
  factsOf,
  now,
}: {
  sections: readonly VisibleSidebarSection[];
  pinned: readonly SidebarWorkRef[];
  work: readonly SidebarWorkRef[];
  all: readonly SidebarWorkRef[];
  projectIds: ReadonlySet<string>;
  factsOf: (ref: SidebarWorkRef) => SidebarWorkFacts;
  now: number;
}): SidebarSectionMembership => {
  const claimedKeys = new Set<string>();
  const claimedProjectIds = new Set<string>();
  const custom = new Map<string, readonly SidebarWorkRef[]>();
  const projectGroups = new Map<string, readonly string[]>();
  let pinnedRefs: readonly SidebarWorkRef[] = [];
  let workRefs: readonly SidebarWorkRef[] = [];
  const show = (refs: readonly SidebarWorkRef[], outOfProjects: boolean): void => {
    if (outOfProjects) for (const ref of refs) claimedKeys.add(ref.key);
  };
  for (const section of sections) {
    switch (section.kind) {
      case 'pages':
      case 'chats':
      case 'projects':
        continue;
      case 'pinned':
        pinnedRefs = [...pinned];
        show(pinnedRefs, section.claims);
        continue;
      case 'work':
        workRefs = [...work];
        show(workRefs, section.claims);
        continue;
      case 'custom': {
        const { section: definition } = section;
        if (definition.grouping === 'project') {
          const ids = definition.filter.projectIds.filter((id) => projectIds.has(id) && !claimedProjectIds.has(id));
          projectGroups.set(definition.id, ids);
          ids.forEach((id) => claimedProjectIds.add(id));
          continue;
        }
        const refs = hasSidebarSectionConditions(definition.filter)
          ? all.filter((ref) => matchesSidebarSectionFilter(definition.filter, factsOf(ref), now))
          : [];
        custom.set(definition.id, refs);
        show(refs, definition.claims);
        continue;
      }
    }
  }
  return { pinned: pinnedRefs, work: workRefs, custom, projectGroups, claimedKeys, claimedProjectIds };
};
