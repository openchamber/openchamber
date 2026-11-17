import { useEffect, useRef, type RefObject } from 'react';
import type { FileDiff as PierreFileDiff, FileDiffMetadata } from '@pierre/diffs';
import { waitForDiffReady } from './diffDom';
import { resolveContextExpansionRequest } from './contextExpansion';
import type { ContextExpansionRequest, DiffAnnotation } from './types';

interface ContextExpansionInput {
  diffContainerRef: RefObject<HTMLDivElement | null>;
  diffInstanceRef: RefObject<PierreFileDiff<DiffAnnotation> | null>;
  requestTrailingExpansionRef: RefObject<() => void>;
  fileDiff: FileDiffMetadata | undefined;
  expandOnDemand: boolean;
  expandLoading: boolean;
  onExpandContextRequest: ((request: ContextExpansionRequest) => void) | undefined;
  pendingContextExpansion: ContextExpansionRequest | null;
}

export const useContextExpansion = ({
  diffContainerRef,
  diffInstanceRef,
  requestTrailingExpansionRef,
  fileDiff,
  expandOnDemand,
  expandLoading,
  onExpandContextRequest,
  pendingContextExpansion,
}: ContextExpansionInput): void => {
  useEffect(() => {
    requestTrailingExpansionRef.current = () => {
      if (expandLoading) return;
      onExpandContextRequest?.({ gap: 'after-last-hunk' });
    };
  }, [expandLoading, onExpandContextRequest, requestTrailingExpansionRef]);

  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container) return;
    return waitForDiffReady(container, () => {
      const host = container.querySelector('diffs-container');
      if (!(host instanceof HTMLElement)) return;
      host.toggleAttribute('data-oc-expand-on-demand', expandOnDemand);
      host.toggleAttribute('data-oc-expand-loading', expandLoading);
    });
  }, [diffContainerRef, expandLoading, expandOnDemand, fileDiff]);

  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container || !expandOnDemand || expandLoading || !fileDiff || !onExpandContextRequest) return;

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const request = resolveContextExpansionRequest(event.composedPath(), fileDiff);
      if (!request) return;
      event.preventDefault();
      event.stopPropagation();
      onExpandContextRequest(request);
    };

    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [diffContainerRef, expandLoading, expandOnDemand, fileDiff, onExpandContextRequest]);

  const appliedContextExpansionRef = useRef<ContextExpansionRequest | null>(null);
  useEffect(() => {
    if (!pendingContextExpansion || !fileDiff || fileDiff.isPartial) return;
    if (appliedContextExpansionRef.current === pendingContextExpansion) return;
    const container = diffContainerRef.current;
    if (!container) return;

    return waitForDiffReady(container, () => {
      const instance = diffInstanceRef.current;
      if (!instance || instance.fileDiff !== fileDiff) return;
      if (appliedContextExpansionRef.current === pendingContextExpansion) return;
      appliedContextExpansionRef.current = pendingContextExpansion;
      if (pendingContextExpansion.gap === 'after-last-hunk') {
        // external: https://github.com/pierrecomputer/pierre The trailing region uses the hunk count and expands from its start with direction 'up'.
        instance.expandHunk(fileDiff.hunks.length, 'up');
        return;
      }
      const hunkIndex = fileDiff.hunks.findIndex((hunk) =>
        hunk.additionStart <= pendingContextExpansion.additionStart
        && pendingContextExpansion.additionStart < hunk.additionStart + Math.max(hunk.additionCount, 1));
      if (hunkIndex < 0) return;
      instance.expandHunk(hunkIndex, pendingContextExpansion.direction);
    });
  }, [diffContainerRef, diffInstanceRef, fileDiff, pendingContextExpansion]);
};
