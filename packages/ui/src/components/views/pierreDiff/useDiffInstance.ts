import { useEffect, useRef, type RefObject } from 'react';
import {
  areFilesEqual,
  areOptionsEqual,
  FileDiff as PierreFileDiff,
  VirtualizedFileDiff,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
  type Virtualizer,
} from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { makeContentCacheKey } from './contentCacheKey';
import { preserveScrollPosition, waitForDiffReady } from './diffDom';
import { isSameSelection } from './diffSelection';
import {
  acquireSharedVirtualizer,
  diffVirtualMetrics,
  wakeVirtualizer,
  type SharedVirtualizer,
} from './sharedVirtualizer';
import type { DiffAnnotation } from './types';

interface DiffInstanceInput {
  diffRootRef: RefObject<HTMLDivElement | null>;
  diffContainerRef: RefObject<HTMLDivElement | null>;
  diffInstanceRef: RefObject<PierreFileDiff<DiffAnnotation> | null>;
  sharedVirtualizerRef: RefObject<SharedVirtualizer | null>;
  instanceVirtualizerRef: RefObject<Virtualizer | null>;
  workerPool: WorkerPoolManager | undefined;
  fileDiff: FileDiffMetadata | undefined;
  fileName: string | undefined;
  language: string;
  original: string;
  modified: string;
  options: FileDiffOptions<DiffAnnotation, undefined>;
  diffThemeKey: string;
  diffLineHeight: number;
  holdTypingField: () => void;
  lineAnnotations: DiffLineAnnotation<DiffAnnotation>[];
  lineAnnotationsRef: RefObject<DiffLineAnnotation<DiffAnnotation>[]>;
  selection: SelectedLineRange | null;
  selectionRef: RefObject<SelectedLineRange | null>;
  isApplyingSelectionRef: RefObject<boolean>;
  lastAppliedSelectionRef: RefObject<SelectedLineRange | null>;
  paintSelection: (range: SelectedLineRange) => void;
  forceUpdate: () => void;
}

export const useDiffInstance = ({
  diffRootRef,
  diffContainerRef,
  diffInstanceRef,
  sharedVirtualizerRef,
  instanceVirtualizerRef,
  workerPool,
  fileDiff,
  fileName,
  language,
  original,
  modified,
  options,
  diffThemeKey,
  diffLineHeight,
  holdTypingField,
  lineAnnotations,
  lineAnnotationsRef,
  selection,
  selectionRef,
  isApplyingSelectionRef,
  lastAppliedSelectionRef,
  paintSelection,
  forceUpdate,
}: DiffInstanceInput): void => {
  const instanceWorkerPoolRef = useRef<unknown>(null);
  const instanceVirtualHunkSeparatorsRef = useRef<FileDiffOptions<DiffAnnotation, undefined>['hunkSeparators'] | undefined>(undefined);
  const instanceLineHeightRef = useRef<number | undefined>(undefined);
  const instanceFileDiffRef = useRef<FileDiffMetadata | undefined>(undefined);
  const instanceOldFileRef = useRef<FileContents | undefined>(undefined);
  const instanceNewFileRef = useRef<FileContents | undefined>(undefined);

  useEffect(() => {
    const container = diffContainerRef.current;
    return () => {
      diffInstanceRef.current?.cleanUp();
      diffInstanceRef.current = null;
      sharedVirtualizerRef.current?.release();
      sharedVirtualizerRef.current = null;
      instanceVirtualizerRef.current = null;
      instanceWorkerPoolRef.current = null;
      instanceVirtualHunkSeparatorsRef.current = undefined;
      instanceLineHeightRef.current = undefined;
      instanceFileDiffRef.current = undefined;
      instanceOldFileRef.current = undefined;
      instanceNewFileRef.current = undefined;
      if (container) {
        container.innerHTML = '';
      }
    };
  }, [diffContainerRef, diffInstanceRef, instanceVirtualizerRef, sharedVirtualizerRef]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const container = diffContainerRef.current;
    const wrapper = diffRootRef.current;
    if (!container) return;
    if (!workerPool) return;

    const preserveDone = preserveScrollPosition(wrapper, container);
    let sharedVirtualizer = sharedVirtualizerRef.current;
    if (!sharedVirtualizer) {
      sharedVirtualizer = acquireSharedVirtualizer(container);
      sharedVirtualizerRef.current = sharedVirtualizer;
    }
    sharedVirtualizerRef.current = sharedVirtualizer;
    const virtualizer = sharedVirtualizer?.virtualizer ?? null;

    const oldFile: FileContents | undefined = fileDiff ? undefined : {
      name: fileName || '',
      contents: original,
      lang: language as FileContents['lang'],
      cacheKey: `old:${diffThemeKey}:${fileName}:${makeContentCacheKey(original)}`,
    };
    const newFile: FileContents | undefined = fileDiff ? undefined : {
      name: fileName || '',
      contents: modified,
      lang: language as FileContents['lang'],
      cacheKey: `new:${diffThemeKey}:${fileName}:${makeContentCacheKey(modified)}`,
    };

    const targetChanged = fileDiff
      ? instanceFileDiffRef.current !== fileDiff
      : instanceFileDiffRef.current !== undefined
        || !oldFile
        || !newFile
        || !instanceOldFileRef.current
        || !instanceNewFileRef.current
        || !areFilesEqual(instanceOldFileRef.current, oldFile)
        || !areFilesEqual(instanceNewFileRef.current, newFile);

    const currentInstance = diffInstanceRef.current;
    const shouldReset = Boolean(
      currentInstance
      && (
        instanceVirtualizerRef.current !== virtualizer
        || instanceWorkerPoolRef.current !== workerPool
        || (virtualizer && (instanceVirtualHunkSeparatorsRef.current !== options.hunkSeparators || targetChanged))
      )
    );

    holdTypingField();
    if (shouldReset) {
      currentInstance?.cleanUp();
      diffInstanceRef.current = null;
      container.innerHTML = '';
    }

    let instance = diffInstanceRef.current;
    let rebuiltInstance = false;
    const lineHeightChanged = Boolean(instance) && instanceLineHeightRef.current !== diffLineHeight;
    const forceRender = !shouldReset && currentInstance
      ? !areOptionsEqual(currentInstance.options, options) || lineHeightChanged
      : false;
    if (!instance) {
      instance = sharedVirtualizer
        ? new VirtualizedFileDiff<DiffAnnotation>(
            options,
            sharedVirtualizer.virtualizer,
            diffVirtualMetrics(diffLineHeight),
            workerPool,
          )
        : new PierreFileDiff(options, workerPool);
      diffInstanceRef.current = instance;
      lastAppliedSelectionRef.current = null;
      rebuiltInstance = true;
    } else {
      instance.setOptions(options);
      const current: unknown = instance;
      if (lineHeightChanged && current instanceof VirtualizedFileDiff) {
        current.setMetrics(diffVirtualMetrics(diffLineHeight));
      }
    }

    instanceVirtualizerRef.current = virtualizer;
    instanceWorkerPoolRef.current = workerPool;
    instanceVirtualHunkSeparatorsRef.current = virtualizer ? options.hunkSeparators : undefined;
    instanceLineHeightRef.current = diffLineHeight;
    instanceFileDiffRef.current = fileDiff;
    instanceOldFileRef.current = oldFile;
    instanceNewFileRef.current = newFile;

    if (fileDiff) {
      instance.render({
        fileDiff,
        forceRender,
        lineAnnotations: lineAnnotationsRef.current,
        containerWrapper: container,
      });
    } else {
      if (!oldFile || !newFile) return;

      instance.render({
        oldFile,
        newFile,
        forceRender,
        lineAnnotations: lineAnnotationsRef.current,
        containerWrapper: container,
      });
    }

    if (rebuiltInstance && selectionRef.current) paintSelection(selectionRef.current);

    const cancelReady = waitForDiffReady(container, () => {
      preserveDone();
      wakeVirtualizer(instance, sharedVirtualizer, forceUpdate);
    });

    return () => {
      cancelReady();
      preserveDone();
    };
  }, [diffContainerRef, diffInstanceRef, diffLineHeight, diffRootRef, diffThemeKey, fileDiff, fileName, forceUpdate, holdTypingField, instanceVirtualizerRef, language, lastAppliedSelectionRef, lineAnnotationsRef, modified, options, original, paintSelection, selectionRef, sharedVirtualizerRef, workerPool]);

  useEffect(() => {
    const instance = diffInstanceRef.current;
    if (!instance) return;

    try {
      instance.setLineAnnotations(lineAnnotations);
    } catch (error) {
      console.error('Failed to apply diff line annotations', error);
      try {
        instance.setLineAnnotations([]);
      } catch {
        // ignored
      }
    }

    requestAnimationFrame(() => {
      if (diffInstanceRef.current !== instance) return;
      holdTypingField();
      try {
        instance.rerender();
      } catch (err) {
        void err;
      }
      forceUpdate();
    });
  }, [diffInstanceRef, forceUpdate, holdTypingField, lineAnnotations]);

  useEffect(() => {
    const instance = diffInstanceRef.current;
    if (!instance) return;

    if (selection !== null) {
      return;
    }

    const lastApplied = lastAppliedSelectionRef.current;
    if (isSameSelection(selection, lastApplied)) {
      return;
    }

    try {
      isApplyingSelectionRef.current = true;
      instance.setSelectedLines(selection);
      lastAppliedSelectionRef.current = selection;
    } catch {
      // ignore
    } finally {
      isApplyingSelectionRef.current = false;
    }
  }, [diffInstanceRef, isApplyingSelectionRef, lastAppliedSelectionRef, selection]);
};
