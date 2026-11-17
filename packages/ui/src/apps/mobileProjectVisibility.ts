import type { Session } from '@/lib/opencode/model';

/** Project visibility flags (#217), mirroring the desktop List view
    consumers in SessionProjectCollection: a project can be hidden from
    the In work zone (hiddenFromWork) and from All sessions lists
    (hiddenFromAllSessions). The flags live on the project entry; the
    sets below are the sheet-side form of the desktop sets. */
type ProjectVisibilitySource = {
  id: string;
  hiddenFromWork?: boolean;
  hiddenFromAllSessions?: boolean;
};

type ProjectVisibilitySets = {
  hiddenFromWorkProjectIds: ReadonlySet<string>;
  hiddenFromAllProjectIds: ReadonlySet<string>;
};

export const projectVisibilitySets = (
  projects: readonly ProjectVisibilitySource[],
): ProjectVisibilitySets => ({
  hiddenFromWorkProjectIds: new Set(
    projects.filter((project) => project.hiddenFromWork).map((project) => project.id),
  ),
  hiddenFromAllProjectIds: new Set(
    projects.filter((project) => project.hiddenFromAllSessions).map((project) => project.id),
  ),
});

/** Resolves a session to its owner project id (the sheet ownership
    index), or null/undefined when no registered project owns it.
    Ownerless sessions are never hidden: the desktop filter keeps an
    item whose project is unknown. */
type SessionProjectOwner = (session: Session) => string | null | undefined;

export const isSessionHiddenFromWork = (
  session: Session,
  ownerOf: SessionProjectOwner,
  visibility: ProjectVisibilitySets,
): boolean => {
  const projectId = ownerOf(session);
  return projectId != null && visibility.hiddenFromWorkProjectIds.has(projectId);
};

export const isSessionHiddenFromAllSessions = (
  session: Session,
  ownerOf: SessionProjectOwner,
  visibility: ProjectVisibilitySets,
): boolean => {
  const projectId = ownerOf(session);
  return projectId != null && visibility.hiddenFromAllProjectIds.has(projectId);
};

/** The sessions that may appear in the sheet In work zone: hiddenFromWork
    projects sessions leave the zone, as on the desktop sidebar. */
export const filterSessionsForWorkZone = (
  sessions: readonly Session[],
  ownerOf: SessionProjectOwner,
  visibility: ProjectVisibilitySets,
): Session[] => sessions.filter((session) => !isSessionHiddenFromWork(session, ownerOf, visibility));

/** The sessions that may appear in All-sessions surfaces (the sheet
    grouped tree buckets and its List/timeline lists): hiddenFromAllSessions
    projects sessions leave those lists; the project itself stays. */
export const filterSessionsForAllSessions = (
  sessions: readonly Session[],
  ownerOf: SessionProjectOwner,
  visibility: ProjectVisibilitySets,
): Session[] =>
  sessions.filter((session) => !isSessionHiddenFromAllSessions(session, ownerOf, visibility));
