import {
  hasSidebarSectionConditions,
  matchesSidebarSectionFilter,
  type BuiltinSidebarSectionId,
  type CustomSidebarSection,
  type SidebarSectionEntry,
  type SidebarWorkFacts,
} from '@/lib/sidebarSections';
import type { SidebarWorkRef } from '../works/sidebarWorks';

/**
 * A section the sidebar draws, in order. `claims`: it takes its works out of
 * their projects; a group of projects always takes its projects from Projects. `preview`: the section being edited, drawn as it stands.
 */
export type VisibleSidebarSection =
  | { kind: 'chats' }
  | { kind: 'pinned' }
  | { kind: 'work'; claims: boolean }
  | { kind: 'custom'; section: CustomSidebarSection; preview: boolean }
  | { kind: 'projects' };

/**
 * The sections a surface draws, in the saved order. The built-in ones follow
 * their show toggles; the user's follow the surface's hidden list, and the
 * section being edited shows whatever the list says (a new one under Pinned).
 */
export const resolveVisibleSidebarSections = ({
  sections,
  hiddenSections,
  draft,
  draftIsNew,
  show,
  keepWorkInPlace,
  customSections,
}: {
  sections: readonly SidebarSectionEntry[];
  hiddenSections: readonly string[];
  draft: CustomSidebarSection | null;
  draftIsNew: boolean;
  show: Readonly<Record<Exclude<BuiltinSidebarSectionId, 'projects'>, boolean>>;
  keepWorkInPlace: boolean;
  /** False where the user's sections do not apply (VS Code). */
  customSections: boolean;
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
        case 'chats': return show.chats ? [{ kind: 'chats' }] : [];
        case 'pinned': return show.pinned ? [{ kind: 'pinned' }] : [];
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
  /** Pinned root sessions and pinned worktree works the Pinned section lists. */
  pinned: readonly SidebarWorkRef[];
  /** The works In work lists. */
  work: readonly SidebarWorkRef[];
  /** Each of the user's sections listed by time: its works, in order. */
  custom: ReadonlyMap<string, readonly SidebarWorkRef[]>;
  /** Each group of projects: the projects it lists, in the filter's order. */
  projectGroups: ReadonlyMap<string, readonly string[]>;
  /** Works a section took out of their projects. */
  claimedKeys: ReadonlySet<string>;
  /** Works a section lists and leaves in their projects too; they leave them during a search only. */
  listedKeys: ReadonlySet<string>;
  /** Projects a group of projects took from the Projects section and the list by time. */
  claimedProjectIds: ReadonlySet<string>;
};

/**
 * Which works each section lists. The user's sections list every work that
 * matches, so one work can show in several; a section that takes its works
 * (`claims`) takes them out of their projects only. Pinned and In work keep
 * taking works from each other by their order, and a group of projects takes
 * its projects from the Projects section.
 */
export const resolveSidebarSectionMembership = ({
  sections,
  pinned,
  work,
  all,
  projectIds,
  factsOf,
  now,
  search,
}: {
  sections: readonly VisibleSidebarSection[];
  /** Candidates of the built-in sections, in their own order. */
  pinned: readonly SidebarWorkRef[];
  work: readonly SidebarWorkRef[];
  /** Every work, most recent first: the candidates of the user's sections. */
  all: readonly SidebarWorkRef[];
  /** The projects the sidebar knows, for groups of projects. */
  projectIds: ReadonlySet<string>;
  factsOf: (ref: SidebarWorkRef) => SidebarWorkFacts;
  now: number;
  /** A search lists each match once, in the first section that shows it. */
  search: boolean;
}): SidebarSectionMembership => {
  const claimedKeys = new Set<string>();
  const listedKeys = new Set<string>();
  const claimedProjectIds = new Set<string>();
  const custom = new Map<string, readonly SidebarWorkRef[]>();
  const projectGroups = new Map<string, readonly string[]>();
  // Pinned and In work take their works from each other, as they always did:
  // the one higher up lists a work that is both pinned and in work.
  const takenByBuiltin = new Set<string>();
  let pinnedRefs: readonly SidebarWorkRef[] = [];
  let workRefs: readonly SidebarWorkRef[] = [];
  // A search lists each match once, in the first section that shows it.
  const unshown = (refs: readonly SidebarWorkRef[]): SidebarWorkRef[] => (
    search ? refs.filter((ref) => !claimedKeys.has(ref.key) && !listedKeys.has(ref.key)) : [...refs]
  );
  const show = (refs: readonly SidebarWorkRef[], outOfProjects: boolean): void => {
    for (const ref of refs) (outOfProjects ? claimedKeys : listedKeys).add(ref.key);
  };
  for (const section of sections) {
    switch (section.kind) {
      case 'chats':
      case 'projects':
        continue;
      case 'pinned':
        // A pinned work always leaves its project: the section is there by choice.
        pinnedRefs = unshown(pinned).filter((ref) => !takenByBuiltin.has(ref.key));
        pinnedRefs.forEach((ref) => takenByBuiltin.add(ref.key));
        show(pinnedRefs, true);
        continue;
      case 'work':
        workRefs = unshown(work).filter((ref) => !takenByBuiltin.has(ref.key));
        if (section.claims) workRefs.forEach((ref) => takenByBuiltin.add(ref.key));
        show(workRefs, section.claims);
        continue;
      case 'custom': {
        const { section: definition } = section;
        if (definition.grouping === 'project') {
          // A project is drawn in one place: the first group that names it has it.
          const ids = definition.filter.projectIds.filter((id) => projectIds.has(id) && !claimedProjectIds.has(id));
          projectGroups.set(definition.id, ids);
          ids.forEach((id) => claimedProjectIds.add(id));
          continue;
        }
        // The user's sections show every work that matches, whatever the
        // other sections show; only the projects lose what they take.
        const refs = hasSidebarSectionConditions(definition.filter)
          ? unshown(all).filter((ref) => matchesSidebarSectionFilter(definition.filter, factsOf(ref), now))
          : [];
        custom.set(definition.id, refs);
        show(refs, definition.claims);
        continue;
      }
    }
  }
  for (const key of claimedKeys) listedKeys.delete(key);
  return { pinned: pinnedRefs, work: workRefs, custom, projectGroups, claimedKeys, listedKeys, claimedProjectIds };
};
