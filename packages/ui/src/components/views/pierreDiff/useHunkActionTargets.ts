import React, { useCallback } from 'react';
import type { FileDiffMetadata, FileDiffOptions, OnDiffLineEnterLeaveProps } from '@pierre/diffs';
import type { PatchHunkAnchor } from '@/lib/diff/patchFileDiff';
import type { DiffAnnotation, DiffHunkActions } from './types';

const EMPTY_HUNK_ANCHORS: readonly PatchHunkAnchor[] = [];

export const useHunkActionTargets = (hunkActions: DiffHunkActions | undefined) => {
  const hunkAnchors = hunkActions?.anchors ?? EMPTY_HUNK_ANCHORS;
  const [hoveredHunk, setHoveredHunk] = React.useState<number | null>(null);
  const handleHunkLineEnter = useCallback((props: OnDiffLineEnterLeaveProps) => {
    const hunk = hunkAnchors.find(({ span }) => {
      const [first, last] = span[props.annotationSide];
      return props.lineNumber >= first && props.lineNumber <= last;
    });
    setHoveredHunk(hunk ? hunk.index : null);
  }, [hunkAnchors]);
  const handleHunkLineLeave = useCallback(() => setHoveredHunk(null), []);
  const [hunkTargets, setHunkTargets] = React.useState<{
    fileDiff: FileDiffMetadata | undefined;
    anchors: readonly PatchHunkAnchor[];
    targets: ReadonlyMap<number, HTMLElement>;
  }>(() => ({ fileDiff: undefined, anchors: EMPTY_HUNK_ANCHORS, targets: new Map() }));

  const captureHunkTargets = useCallback<NonNullable<FileDiffOptions<DiffAnnotation, undefined>['onPostRender']>>((node, instance, phase) => {
    const targets = new Map<number, HTMLElement>();
    if (phase !== 'unmount') {
      const capsuleHeight = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 2;
      const columns = new Map<HTMLElement, DOMRect>();
      const placements: Array<{ target: HTMLElement; offset: number }> = [];
      for (const slot of node.shadowRoot?.querySelectorAll('slot') ?? []) {
        for (const wrapper of slot.assignedElements()) {
          const target = wrapper.querySelector<HTMLElement>('[data-hunk-action-target]');
          const index = Number(target?.dataset.hunkActionTarget);
          if (!target || !Number.isInteger(index) || index < 0) continue;
          targets.set(index, target);
          const column = slot.closest<HTMLElement>('[data-code]');
          if (!column) continue;
          let bounds = columns.get(column);
          if (!bounds) {
            bounds = column.getBoundingClientRect();
            // external: https://github.com/pierrecomputer/pierre Wrapped split columns use display: contents and have no box; their content grid supplies bounds.
            if (bounds.height === 0) bounds = slot.closest('[data-content]')?.getBoundingClientRect() ?? bounds;
            columns.set(column, bounds);
          }
          const markerTop = target.getBoundingClientRect().top;
          const lastLine = slot.closest('[data-line-annotation]')?.previousElementSibling?.getBoundingClientRect();
          const centre = lastLine && lastLine.height > 0 ? lastLine.top + lastLine.height / 2 : markerTop - capsuleHeight / 2;
          const top = Math.max(bounds.top + 2, Math.min(centre - capsuleHeight / 2, bounds.bottom - capsuleHeight - 2));
          placements.push({ target, offset: top - markerTop });
        }
      }
      for (const { target, offset } of placements) {
        const value = `${offset}px`;
        if (target.style.getPropertyValue('--oc-hunk-action-offset') !== value) {
          target.style.setProperty('--oc-hunk-action-offset', value);
        }
      }
    }
    const renderedDiff = instance.fileDiff;
    setHunkTargets((previous) => {
      if (previous.fileDiff === renderedDiff && previous.anchors === hunkAnchors
          && previous.targets.size === targets.size
          && [...targets].every(([index, target]) => previous.targets.get(index) === target)) return previous;
      return { fileDiff: renderedDiff, anchors: hunkAnchors, targets };
    });
  }, [hunkAnchors]);

  return { hunkAnchors, hoveredHunk, hunkTargets, handleHunkLineEnter, handleHunkLineLeave, captureHunkTargets };
};
