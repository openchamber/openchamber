import React from 'react';
import type { SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import type { SessionNode } from '../types';
import { formatProjectLabel, normalizePath } from '../utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatDirectoryName } from '@/lib/utils';
import { resolveTooltipBranchLabel } from './sessionNodeItemUtils';
import type { SecondaryMeta } from './sessionNodeItemProps';
import { useSessionRowGuestMarks } from './useRowGuestMarks';
import { useSessionRefLines } from './useSessionRefLines';

type SessionRowContextInput = {
  node: SessionNode;
  projectId: string | null | undefined;
  secondaryMeta: SecondaryMeta | null | undefined;
  renderContext: SessionSidebarRenderContext;
  archivedBucket: boolean;
  isVSCode: boolean;
  sessionDirectory: string | null;
  sessionProjectId: string | null | undefined;
  projectRootDirectory: string | null;
};

/** What a row says about where its session lives: project and branch labels, the PR and issue links, and the extensions' marks. */
export function useSessionRowContext({
  node,
  projectId,
  secondaryMeta,
  renderContext,
  archivedBucket,
  isVSCode,
  sessionDirectory,
  sessionProjectId,
  projectRootDirectory,
}: SessionRowContextInput) {
  const session = node.session;
  // Tooltip context: recent rows receive project/branch via secondaryMeta;
  // project rows resolve them from the row's own props/node instead.
  const projectLabelFromStore = useProjectsStore(
    React.useCallback((state) => {
      if (secondaryMeta?.projectLabel || !projectId) return null;
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) return null;
      return project.label?.trim() || formatDirectoryName(normalizePath(project.path) ?? project.path, null) || project.path;
    }, [projectId, secondaryMeta?.projectLabel]),
  );
  // Detailed zone rows name the project with its icon on their second line;
  // one-line rows leave that room to the title (the row's tooltip names the
  // project). The row reads exactly that one project record, and `find` keeps
  // the reference stable between renders.
  const timelineProject = useProjectsStore(
    React.useCallback((state) => {
      if (renderContext !== 'timeline-mixed' || !projectId) return null;
      return state.projects.find((entry) => entry.id === projectId) ?? null;
    }, [renderContext, projectId]),
  );
  const tooltipProjectLabel = secondaryMeta?.projectLabel
    ?? (projectLabelFromStore ? formatProjectLabel(projectLabelFromStore) : null);
  // A null branchLabel on an explicit secondaryMeta is a deliberate filter
  // (HEAD/redundant with the project label), so it must not fall through to
  // the raw worktree branch. Project rows pass no secondaryMeta and keep the
  // worktree fallback.
  const tooltipBranchLabel = resolveTooltipBranchLabel(secondaryMeta, node.worktree?.branch ?? null);
  // A space's name stands where a branch would; the mark beside it is the space's, as on its group.
  const branchInSpace = secondaryMeta?.inSpace === true;
  const { refLines, branchPrIconColor } = useSessionRefLines(session, node.worktree, isVSCode);
  const primaryRef = refLines[0] ?? null;
  const moreRefCount = Math.max(0, refLines.length - 1);
  // Extensions' marks (`contributes.marks`); VS Code loads no extensions.
  // In the tree a row without a worktree lies in the project root, whatever
  // subfolder the session started in; elsewhere only the root itself counts.
  const guestMarks = useSessionRowGuestMarks({
    shown: !isVSCode,
    sessionId: session.id,
    directory: sessionDirectory,
    projectId: sessionProjectId ?? null,
    projectRoot: projectRootDirectory,
    worktree: node.worktree,
    inProjectTree: renderContext === 'project' && !archivedBucket,
    metaBranch: branchInSpace ? null : secondaryMeta?.branchLabel ?? null,
  });
  return {
    timelineProject,
    tooltipProjectLabel,
    tooltipBranchLabel,
    branchInSpace,
    refLines,
    branchPrIconColor,
    primaryRef,
    moreRefCount,
    guestMarks,
  };
}
