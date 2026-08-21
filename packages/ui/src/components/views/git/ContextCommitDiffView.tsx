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
}

export const ContextCommitDiffView: React.FC<ContextCommitDiffViewProps> = ({
  directory,
  target,
  onClose,
}) => {
  const { git } = useRuntimeAPIs();

  const comparison = React.useMemo<GitCommitComparison>(() => ({
    directory,
    commitHash: target.commitHash,
    parentHash: target.parentHash,
  }), [directory, target.commitHash, target.parentHash]);

  const controller = React.useMemo(() => createGitCommitDetailsController({
    directory,
    git,
    scheduleIdle: scheduleGitCommitDetailsIdle,
  }), [directory, git, target]);

  React.useEffect(() => {
    controller.selectFile(comparison, target.file);
    return () => {
      controller.dispose();
    };
  }, [comparison, controller, target.file]);

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
