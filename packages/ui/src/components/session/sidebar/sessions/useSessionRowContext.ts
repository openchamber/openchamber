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
  const projectLabelFromStore = useProjectsStore(
    React.useCallback((state) => {
      if (secondaryMeta?.projectLabel || !projectId) return null;
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) return null;
      return project.label?.trim() || formatDirectoryName(normalizePath(project.path) ?? project.path, null) || project.path;
    }, [projectId, secondaryMeta?.projectLabel]),
  );
  const timelineProject = useProjectsStore(
    React.useCallback((state) => {
      if (renderContext !== 'timeline-mixed' || !projectId) return null;
      return state.projects.find((entry) => entry.id === projectId) ?? null;
    }, [renderContext, projectId]),
  );
  const tooltipProjectLabel = secondaryMeta?.projectLabel
    ?? (projectLabelFromStore ? formatProjectLabel(projectLabelFromStore) : null);
  const tooltipBranchLabel = resolveTooltipBranchLabel(secondaryMeta, node.worktree?.branch ?? null);
  const branchInSpace = secondaryMeta?.inSpace === true;
  const { refLines, branchPrIconColor } = useSessionRefLines(session, node.worktree, isVSCode);
  const primaryRef = refLines[0] ?? null;
  const moreRefCount = Math.max(0, refLines.length - 1);
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
