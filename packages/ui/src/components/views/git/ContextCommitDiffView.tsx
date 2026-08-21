import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitCommitDiffTarget } from '@/stores/useUIStore';
import { GitCommitDiffPreview } from './GitCommitDiffPreview';
import {
  createGitCommitDetailsController,
  type GitCommitComparison,
  type GitCommitDetailsController,
} from './gitCommitDetailsController';

const scheduleGitCommitDetailsIdle = (callback: () => void) => {
  if ('requestIdleCallback' in globalThis && 'cancelIdleCallback' in globalThis) {
    const handle = globalThis.requestIdleCallback(callback);
    return () => globalThis.cancelIdleCallback(handle);
  }

  const handle = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(handle);
};

export interface ContextCommitDiffViewProps {
  directory: string;
  target: GitCommitDiffTarget;
  onClose: () => void;
  createController?: typeof createGitCommitDetailsController;
}

const createContextCommitFileKey = (target: GitCommitDiffTarget): string => JSON.stringify([
  target.file.path,
  target.file.originalPath ?? null,
  target.file.status,
  target.file.kind,
  target.file.originalObjectId ?? null,
  target.file.objectId ?? null,
  target.file.insertions,
  target.file.deletions,
  target.file.isBinary,
]);

export const ContextCommitDiffView: React.FC<ContextCommitDiffViewProps> = ({
  directory,
  target,
  onClose,
  createController = createGitCommitDetailsController,
}) => {
  const { git } = useRuntimeAPIs();
  const fileKey = React.useMemo(() => createContextCommitFileKey(target), [
    target.file.deletions,
    target.file.insertions,
    target.file.isBinary,
    target.file.kind,
    target.file.objectId,
    target.file.originalObjectId,
    target.file.originalPath,
    target.file.path,
    target.file.status,
  ]);

  const comparison = React.useMemo<GitCommitComparison>(() => ({
    directory,
    commitHash: target.commitHash,
    parentHash: target.parentHash,
  }), [directory, target.commitHash, target.parentHash]);

  const file = React.useMemo(() => ({ ...target.file }), [fileKey]);

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

  const previewController = React.useMemo<GitCommitDetailsController>(() => ({
    ...controller,
    clearSelection: onClose,
  }), [controller, onClose]);

  return (
    <section
      id="git-commit-context-diff"
      data-git-commit-context-diff="true"
      className="h-full min-h-0"
    >
      <GitCommitDiffPreview
        controller={previewController}
        closeMode="close"
        autoFocusCloseButton={false}
        announceOverlayOpen={false}
      />
    </section>
  );
};
