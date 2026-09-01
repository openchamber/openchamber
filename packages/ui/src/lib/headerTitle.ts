import type { ProjectEntry } from '@/lib/api/types';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import type { WorktreeMetadata } from '@/types/worktree';

type DesktopHeaderTitleOptions = {
  projects: ProjectEntry[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  authoritativeDirectory: string | null;
  activeProjectId: string | null;
  isDraftOpen: boolean;
  draftProjectId: string | null;
  currentSessionId: string | null;
  currentSessionTitle: string | null;
  draftTitle: string;
  untitledTitle: string;
  productTitle: string;
};

const getProjectLabel = (project: ProjectEntry | null): string | null => {
  if (!project) return null;

  const label = project.label?.trim();
  if (label) return label;

  const pathSegments = project.path.split(/[\\/]/).filter(Boolean);
  return pathSegments[pathSegments.length - 1] ?? null;
};

export const deriveDesktopHeaderTitle = ({
  projects,
  availableWorktreesByProject,
  authoritativeDirectory,
  activeProjectId,
  isDraftOpen,
  draftProjectId,
  currentSessionId,
  currentSessionTitle,
  draftTitle,
  untitledTitle,
  productTitle,
}: DesktopHeaderTitleOptions): string => {
  const draftProject = isDraftOpen && draftProjectId
    ? projects.find((project) => project.id === draftProjectId) ?? null
    : null;
  const directoryProject = authoritativeDirectory
    ? resolveProjectForSessionDirectory(projects, availableWorktreesByProject, authoritativeDirectory)
    : null;
  const activeProject = !authoritativeDirectory && !currentSessionId && !isDraftOpen && activeProjectId
    ? projects.find((project) => project.id === activeProjectId) ?? null
    : null;
  const projectLabel = getProjectLabel(draftProject ?? directoryProject ?? activeProject);

  let sessionLabel: string | null = null;
  if (isDraftOpen) {
    sessionLabel = draftTitle;
  } else if (currentSessionId) {
    sessionLabel = currentSessionTitle?.trim() || untitledTitle;
  }

  if (!sessionLabel) {
    return projectLabel ?? productTitle;
  }

  return projectLabel ? `${projectLabel} / ${sessionLabel}` : sessionLabel;
};
