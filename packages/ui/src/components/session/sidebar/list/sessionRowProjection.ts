import type { Session } from '@/lib/opencode/model';
import { DEFAULT_PIN_LIST } from '@/lib/sidebarSections';
import { getSessionPinList } from '@/lib/sessionPins';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';
import type { ProjectSection } from '../projects/sessionProjectRender';
import type { SessionSidebarWorkEntry } from '../sessionSidebarRowModel';
import { getSessionFolderScopes } from '../sessions/sessionFolderIdentity';
import type { SidebarFolderMembership, SidebarWorkRef } from '../works/sidebarWorks';

export const projectPinnedSessionRows = (
  sessionRows: boolean,
  sessions: readonly Session[],
  worktrees: readonly Extract<SidebarWorkRef, { kind: 'group' }>[],
  sessionRef: (session: Session) => SidebarWorkRef,
): SidebarWorkRef[] => {
  const pins: SidebarWorkRef[] = sessionRows
    ? worktrees.flatMap((ref) => ref.group.sessions.length > 0
      ? ref.group.sessions.filter((node) => (getSessionPinList(node.session) ?? DEFAULT_PIN_LIST) === DEFAULT_PIN_LIST).map((node) => sessionRef(node.session))
      : [ref])
    : [...worktrees];
  return [...new Map([...sessions.map(sessionRef), ...pins].map((ref) => [ref.key, ref])).values()];
};

export const buildSidebarFolderMembership = (
  projects: readonly { id: string; normalizedPath: string }[],
  sections: readonly ProjectSection[],
  foldersMap: SessionFoldersMap,
  sessionRows: boolean,
): Map<string, SidebarFolderMembership> => {
  const byMember = new Map<string, SidebarFolderMembership>();
  for (const project of projects) {
    for (const folder of foldersMap[project.normalizedPath] ?? []) {
      for (const memberId of folder.sessionIds) byMember.set(memberId, { folderId: folder.id, projectId: project.id });
    }
  }
  if (sessionRows) for (const section of sections) {
    for (const group of section.groups) {
      for (const { scopeKey } of getSessionFolderScopes(group)) {
        for (const folder of foldersMap[scopeKey] ?? []) {
          for (const memberId of folder.sessionIds) {
            if (!byMember.has(memberId)) byMember.set(memberId, { folderId: folder.id, projectId: section.project.id });
          }
        }
      }
    }
  }
  return byMember;
};

export const projectSessionRowDrafts = (
  sessionRows: boolean,
  works: readonly Extract<SidebarWorkRef, { kind: 'group' }>[],
  drafts: ReadonlyMap<string, readonly SessionDraft[]>,
  claimedProject: (projectId: string) => boolean,
  inFolder: (ref: SidebarWorkRef) => boolean,
  listed: ReadonlySet<string>,
): SessionSidebarWorkEntry[] => sessionRows ? works.flatMap((ref): SessionSidebarWorkEntry[] => (
  ref.group.sessions.length > 0 && !claimedProject(ref.projectId) && !inFolder(ref) && !listed.has(ref.key)
    ? (drafts.get(ref.key) ?? []).map((draft) => ({ kind: 'draft', draft, projectId: ref.projectId }))
    : []
)) : [];
