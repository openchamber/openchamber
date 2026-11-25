import React, { useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  parseDiffFromFile,
  type FileDiff as PierreFileDiff,
  type FileDiffOptions,
  type Virtualizer,
} from '@pierre/diffs';
import { PierreDiffCommentOverlays } from '@/components/comments';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useWorkerPool } from '@/contexts/DiffWorkerProvider';
import { ensurePierreThemeRegistered, getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { DIFFS_HIGHLIGHTER } from '@/lib/shiki/diffsHighlighter';
import { getDefaultTheme } from '@/lib/theme/themes';

import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { hideWhitespaceChanges } from '@/lib/diff/hideWhitespaceChanges';
import { DiffStickyScrollbar } from './DiffStickyScrollbar';
import { useEditorCodeMetrics } from '@/lib/editorCodeMetrics';
import { HIDE_COLUMN_SCROLLBAR_CSS, HUNK_ACTION_OVERLAY_CSS, WEBKIT_SCROLL_FIX_CSS } from './pierreDiff/css';
import { useContextExpansion } from './pierreDiff/useContextExpansion';
import { useAnnotationRenderer, useLineAnnotations } from './pierreDiff/useDiffAnnotations';
import { useDiffComments } from './pierreDiff/useDiffComments';
import { useDiffInstance } from './pierreDiff/useDiffInstance';
import { useDiffScrollToLine } from './pierreDiff/useDiffScrollToLine';
import { useDiffSwapAfterHighlight } from './pierreDiff/useDiffSwapAfterHighlight';
import { useDiffThemeVars } from './pierreDiff/useDiffThemeVars';
import { useFindHighlights, useShadowRootPass } from './pierreDiff/useFindHighlights';
import { useHunkActionTargets } from './pierreDiff/useHunkActionTargets';
import { useLineSelectionGestures } from './pierreDiff/useLineSelectionGestures';
import { DEFAULT_DIFF_LINE_HEIGHT, type SharedVirtualizer } from './pierreDiff/sharedVirtualizer';
import type { DiffAnnotation, PierreDiffViewerHandle, PierreDiffViewerProps } from './pierreDiff/types';

export type {
  ContextExpansionRequest,
  DiffFindWordRequest,
  DiffHunkActions,
  PierreDiffViewerHandle,
} from './pierreDiff/types';


const LARGE_CONTENT_BYTES = 500_000;

export const PierreDiffViewer = React.forwardRef<PierreDiffViewerHandle, PierreDiffViewerProps>(
  function PierreDiffViewer({ hideWhitespace = false, ...props }, ref) {
    const { t } = useI18n();
    const { original, modified, fileDiff, fileName } = props;
    const sourceDiff = useMemo(() => {
      if (!hideWhitespace || fileDiff) return fileDiff;
      return parseDiffFromFile({ name: fileName ?? '', contents: original }, { name: fileName ?? '', contents: modified });
    }, [fileDiff, fileName, hideWhitespace, modified, original]);
    const visibleDiff = useMemo(
      () => (hideWhitespace && sourceDiff ? hideWhitespaceChanges(sourceDiff) : fileDiff),
      [fileDiff, hideWhitespace, sourceDiff],
    );

    if (hideWhitespace && sourceDiff && sourceDiff.hunks.length > 0 && visibleDiff?.hunks.length === 0) {
      return (
        <div className="px-3 py-2 typography-meta text-muted-foreground">
          {t('diffView.state.whitespaceOnly')}
        </div>
      );
    }

    return (
      <PierreDiffViewerBody
        {...props}
        handleRef={ref}
        fileDiff={visibleDiff}
        hunkActions={hideWhitespace ? undefined : props.hunkActions}
      />
    );
  },
);

const PierreDiffViewerBody: React.FC<
  Omit<PierreDiffViewerProps, 'hideWhitespace'> & { handleRef?: React.Ref<PierreDiffViewerHandle> }
> = ({
  original,
  modified,
  fileDiff: incomingFileDiff,
  language,
  fileName,
  commentOrigin,
  renderSideBySide,
  wrapLines,
  layout = 'fill',
  enableComments = true,
  hunkActions,
  onExpandContextRequest,
  pendingContextExpansion = null,
  contextLoading = false,
  onFindWordRequest,
  onUnsavedCommentChange,
  handleRef,
}) => {
  const themeContext = useOptionalThemeSystem();
  const { t } = useI18n();
  const showLinesBelowLabel = t('diffView.actions.showLinesBelow');
  const requestTrailingExpansionRef = useRef<() => void>(() => {});

  const isDark = themeContext?.currentTheme.metadata.variant === 'dark';
  const lightTheme = themeContext?.availableThemes.find(t => t.metadata.id === themeContext.lightThemeId) ?? getDefaultTheme(false);
  const darkTheme = themeContext?.availableThemes.find(t => t.metadata.id === themeContext.darkThemeId) ?? getDefaultTheme(true);

  const { isMobile } = useDeviceInfo();
  const editorCode = useEditorCodeMetrics();
  const diffLineHeight = editorCode?.lineHeight ?? DEFAULT_DIFF_LINE_HEIGHT;
  const {
    hunkAnchors,
    hoveredHunk,
    hunkTargets,
    handleHunkLineEnter,
    handleHunkLineLeave,
    captureHunkTargets,
  } = useHunkActionTargets(hunkActions);

  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const diffContainerRef = useRef<HTMLDivElement | null>(null);
  const diffInstanceRef = useRef<PierreFileDiff<DiffAnnotation> | null>(null);
  const sharedVirtualizerRef = useRef<SharedVirtualizer | null>(null);
  const instanceVirtualizerRef = useRef<Virtualizer | null>(null);

  const {
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    startEdit,
    deleteDraft,
    fileDrafts,
    review,
    reviewItems,
    reviewField,
    excerptOf,
    selectionRef,
    editingDraftIdRef,
    commentTextRef,
    isApplyingSelectionRef,
    lastAppliedSelectionRef,
    handleSelectionChange,
    handleCancelComment,
    handleSaveComment,
    paintSelection,
    applySelection,
  } = useDiffComments({
    original,
    modified,
    incomingFileDiff,
    fileName,
    language,
    commentOrigin,
    enableComments,
    isMobile,
    diffInstanceRef,
    onUnsavedCommentChange,
  });

  const { commentHostsRef, returnTypingField, holdTypingField, renderAnnotation } = useAnnotationRenderer({
    diffContainerRef,
    requestTrailingExpansionRef,
    showLinesBelowLabel,
  });

  const { handleGutterUtilityClick, handleLineClick } = useLineSelectionGestures({
    enableComments,
    onFindWordRequest,
    diffRootRef,
    diffContainerRef,
    diffInstanceRef,
    selectionRef,
    commentTextRef,
    editingDraftIdRef,
    isApplyingSelectionRef,
    setSelection,
    setCommentText,
    applySelection,
  });

  const lightThemeName = ensurePierreThemeRegistered(lightTheme);
  const darkThemeName = ensurePierreThemeRegistered(darkTheme);

  const diffThemeKey = `${lightThemeName}:${darkThemeName}:${isDark ? 'dark' : 'light'}`;

  const isLargeContent = useMemo(() => {
    if (incomingFileDiff) {
      const deletionLength = incomingFileDiff.deletionLines.reduce((total, line) => total + line.length, 0);
      const additionLength = incomingFileDiff.additionLines.reduce((total, line) => total + line.length, 0);
      return Math.max(deletionLength, additionLength) > LARGE_CONTENT_BYTES;
    }

    return Math.max(original.length, modified.length) > LARGE_CONTENT_BYTES;
  }, [incomingFileDiff, modified.length, original.length]);

  const { findMatchesRef, shadowObserverRef, scheduleShadowPassRef, applyFindHighlights, setFindHighlights } = useFindHighlights(diffContainerRef);

  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
  const workerPool = useWorkerPool(isLargeContent ? 'unified' : (renderSideBySide ? 'split' : 'unified'));
  const fileDiff = useDiffSwapAfterHighlight(incomingFileDiff, workerPool);

  const scrollToLine = useDiffScrollToLine({
    fileDiff,
    diffInstanceRef,
    diffContainerRef,
    instanceVirtualizerRef,
    sharedVirtualizerRef,
  });

  React.useImperativeHandle(handleRef, () => ({ scrollToLine, setFindHighlights }), [scrollToLine, setFindHighlights]);
  const expandOnDemand = Boolean(onExpandContextRequest) && fileDiff?.isPartial === true;
  const expandLoading = expandOnDemand && (contextLoading || incomingFileDiff !== fileDiff);

  const lightResolvedTheme = useMemo(() => getResolvedShikiTheme(lightTheme), [lightTheme]);
  const darkResolvedTheme = useMemo(() => getResolvedShikiTheme(darkTheme), [darkTheme]);

  useDiffThemeVars(diffRootRef, isDark, lightResolvedTheme, darkResolvedTheme, diffThemeKey);

  const hasHunkAnchors = hunkAnchors.length > 0;
  const handlePostRender = useCallback<NonNullable<FileDiffOptions<DiffAnnotation, undefined>['onPostRender']>>((node, instance, phase) => {
    if (hasHunkAnchors) captureHunkTargets(node, instance, phase);
    if (phase !== 'unmount' && findMatchesRef.current.length > 0) applyFindHighlights();
    if (phase === 'unmount') return;
    returnTypingField();
  }, [applyFindHighlights, captureHunkTargets, findMatchesRef, hasHunkAnchors, returnTypingField]);

  const options = useMemo<FileDiffOptions<DiffAnnotation, undefined>>(() => ({
    theme: {
      dark: darkThemeName,
      light: lightThemeName,
    },
    themeType: isDark ? 'dark' : 'light',
    preferredHighlighter: DIFFS_HIGHLIGHTER,
    diffStyle: renderSideBySide ? 'split' : 'unified',
    diffIndicators: 'none',
    hunkSeparators: 'line-info-basic',
    lineDiffType: 'none',
    maxLineDiffLength: isLargeContent ? 0 : 1000,
    maxLineLengthForHighlighting: isLargeContent ? 1 : 1000,
    tokenizeMaxLineLength: isLargeContent ? 1 : 1000,
    collapsedContextThreshold: 0,
    expansionLineCount: 20,
    overflow: wrapLines ? 'wrap' : 'scroll',
    disableFileHeader: true,
    enableLineSelection: enableComments,
    enableGutterUtility: enableComments,
    onGutterUtilityClick: enableComments ? handleGutterUtilityClick : undefined,
    onLineClick: enableComments || onFindWordRequest ? handleLineClick : undefined,
    onLineEnter: handleHunkLineEnter,
    onLineLeave: handleHunkLineLeave,
    onLineSelected: enableComments ? handleSelectionChange : undefined,
    unsafeCSS: [
      WEBKIT_SCROLL_FIX_CSS,
      hunkAnchors.length > 0 ? HUNK_ACTION_OVERLAY_CSS : '',
      layout === 'inline' ? HIDE_COLUMN_SCROLLBAR_CSS : '',
    ].join('\n'),
    renderAnnotation: enableComments || hunkAnchors.length > 0 || expandOnDemand ? renderAnnotation : undefined,
    onPostRender: handlePostRender,
  }), [handlePostRender, hunkAnchors.length, darkThemeName, enableComments, expandOnDemand, isDark, isLargeContent, layout, lightThemeName, renderSideBySide, wrapLines, handleSelectionChange, handleGutterUtilityClick, handleLineClick, handleHunkLineEnter, handleHunkLineLeave, onFindWordRequest, renderAnnotation]);

  const { lineAnnotations, lineAnnotationsRef } = useLineAnnotations({
    enableComments,
    fileDrafts,
    editingDraftId,
    reviewItems,
    hunkAnchors,
    expandOnDemand,
    fileDiff,
    selection,
    commentHostsRef,
  });

  useDiffInstance({
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
  });

  useShadowRootPass({
    diffContainerRef,
    forceUpdate,
    applyFindHighlights,
    findMatchesRef,
    shadowObserverRef,
    scheduleShadowPassRef,
    diffThemeKey,
    fileName,
  });

  useContextExpansion({
    diffContainerRef,
    diffInstanceRef,
    requestTrailingExpansionRef,
    fileDiff,
    expandOnDemand,
    expandLoading,
    onExpandContextRequest,
    pendingContextExpansion,
  });

  if (typeof window === 'undefined') {
    return null;
  }

  const commentOverlays = enableComments ? (
    <PierreDiffCommentOverlays
      diffRootRef={diffRootRef}
      drafts={fileDrafts}
      selection={selection}
      editingDraftId={editingDraftId}
      commentText={commentText}
      onTextChange={setCommentText}
      fileLabel={fileName ?? ''}
      onSave={handleSaveComment}
      onCancel={handleCancelComment}
      review={review}
      reviewItems={reviewItems}
      reviewField={reviewField}
      excerptOf={excerptOf}
      onEdit={(draft) => {
        applySelection({
          start: draft.startLine,
          end: draft.endLine,
          side: draft.side === 'original' ? 'deletions' : 'additions',
        });
        startEdit(draft);
      }}
      onDelete={deleteDraft}
    />
  ) : null;

  const hunkActionPortals = hunkActions && fileDiff && hunkTargets.fileDiff === fileDiff && hunkTargets.anchors === hunkAnchors
    ? [...hunkTargets.targets].map(([index, target]) => createPortal(hunkActions.render(index, hoveredHunk === index), target, `hunk-${index}`))
    : null;

  if (layout === 'fill') {
    return (
      <div className={cn("flex flex-col relative", "size-full")} style={editorCode?.style} data-diff-virtual-root onPointerLeave={handleHunkLineLeave}>
        <div className="flex-1 relative min-h-0">
          <ScrollableOverlay
            outerClassName="pierre-diff-wrapper size-full"
            disableHorizontal={false}
            fillContainer={true}
            data-diff-virtual-content
          >
            <div ref={diffRootRef} className="size-full relative">
              <div ref={diffContainerRef} className="size-full" />
            </div>
          </ScrollableOverlay>
          {commentOverlays}
          {hunkActionPortals}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative", "w-full")} onPointerLeave={handleHunkLineLeave}>
      <div ref={diffRootRef} className="pierre-diff-wrapper w-full overflow-x-auto overflow-y-visible relative" style={editorCode?.style}>
      <div ref={diffContainerRef} className="w-full" />
    </div>
    <DiffStickyScrollbar containerRef={diffContainerRef} />
    {commentOverlays}
    {hunkActionPortals}
  </div>
  );
};
