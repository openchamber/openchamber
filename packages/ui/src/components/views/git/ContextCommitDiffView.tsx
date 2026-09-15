import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitCommitDiffTarget } from '@/stores/useUIStore';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { GitCommitDiffPreview } from './GitCommitDiffPreview';
import {
  createGitCommitDetailsController,
  scheduleGitCommitDetailsIdle,
  type GitCommitComparison,
} from './gitCommitDetailsController';

export interface ContextCommitDiffViewProps {
  directory: string;
  target: GitCommitDiffTarget;
  createController?: typeof createGitCommitDetailsController;
}

const createContextCommitFileKey = (file: Pick<GitCommitChangedFile, 'path' | 'status' | 'kind' | 'insertions' | 'deletions' | 'isBinary'> & {
  originalPath: string | null;
  originalObjectId: string | null;
  objectId: string | null;
}): string => JSON.stringify([
  file.path,
  file.originalPath,
  file.status,
  file.kind,
  file.originalObjectId,
  file.objectId,
  file.insertions,
  file.deletions,
  file.isBinary,
]);

export const ContextCommitDiffView: React.FC<ContextCommitDiffViewProps> = ({
  directory,
  target,
  createController = createGitCommitDetailsController,
}) => {
  const { git } = useRuntimeAPIs();
  const commitHash = target.commitHash;
  const parentHash = target.parentHash;
  const filePath = target.file.path;
  const originalPath = target.file.originalPath ?? null;
  const status = target.file.status;
  const kind = target.file.kind;
  const objectId = target.file.objectId ?? null;
  const originalObjectId = target.file.originalObjectId ?? null;
  const insertions = target.file.insertions;
  const deletions = target.file.deletions;
  const isBinary = target.file.isBinary;

  const fileKey = React.useMemo(() => createContextCommitFileKey({
    path: filePath,
    originalPath,
    status,
    kind,
    objectId,
    originalObjectId,
    insertions,
    deletions,
    isBinary,
  }), [
    deletions,
    insertions,
    isBinary,
    kind,
    objectId,
    originalObjectId,
    originalPath,
    filePath,
    status,
  ]);

  const comparison = React.useMemo<GitCommitComparison>(() => ({
    directory,
    commitHash,
    parentHash,
  }), [commitHash, directory, parentHash]);

  const file = React.useMemo(() => ({
    path: filePath,
    originalPath: originalPath ?? undefined,
    status,
    kind,
    objectId: objectId ?? undefined,
    originalObjectId: originalObjectId ?? undefined,
    insertions,
    deletions,
    isBinary,
  }), [
    deletions,
    insertions,
    isBinary,
    kind,
    objectId,
    originalObjectId,
    originalPath,
    filePath,
    status,
  ]);

  const controller = React.useMemo(() => createController({
    directory,
    git,
    scheduleIdle: scheduleGitCommitDetailsIdle,
  }), [createController, directory, git]);

  React.useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  React.useEffect(() => {
    controller.selectFile(comparison, file);
  }, [comparison, controller, file]);

  return (
    <section
      id="git-commit-context-diff"
      data-git-commit-context-diff="true"
      data-git-commit-context-diff-file-key={fileKey}
      className="h-full min-h-0"
    >
      <GitCommitDiffPreview
        controller={controller}
        announceOverlayOpen={false}
      />
    </section>
  );
};
