import React from 'react';
import { SubmoduleDiffSummary } from '../SubmoduleDiffSummary';
import { isDocumentVersions } from '../files/documentVersions';
import { OfficeDocumentDiff } from '../files/OfficeDocumentDiff';
import { getLanguageFromExtension, isImageFile, isOfficePreviewFile } from '@/lib/toolHelpers';
import {
    PierreDiffViewer, type ContextExpansionRequest, type DiffFindWordRequest, type DiffHunkActions,
    type PierreDiffViewerHandle,
} from '../PierreDiffViewer';
import { StatusImage } from '@/components/ui/status-image';
import { useI18n } from '@/lib/i18n';
import { type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import type { DiffData } from './types';

const BinaryDiffPlaceholder = React.memo(() => {
    const { t } = useI18n();
    return (
        <div className="rounded-lg border border-edge bg-background px-3 py-2">
            <div className="typography-meta text-muted-foreground">{t('diffView.binary.unavailable')}</div>
        </div>
    );
});
interface InlineImageDiffViewerProps {
    filePath: string;
    diff: DiffData;
    renderSideBySide: boolean;
}

const InlineImageDiffViewer = React.memo<InlineImageDiffViewerProps>(({
    filePath,
    diff,
    renderSideBySide,
}) => {
    const { t } = useI18n();
    const hasOriginal = diff.original.length > 0;
    const hasModified = diff.modified.length > 0;

    const containerClass = renderSideBySide
        ? 'flex flex-row gap-6 items-start justify-center'
        : 'flex flex-col gap-4 items-center';

    const imageContainerClass = renderSideBySide
        ? 'flex flex-col items-center gap-2 flex-1 min-w-0'
        : 'flex flex-col items-center gap-2';

    return (
        <div className="w-full overflow-auto p-4" style={{ contain: 'layout' }}>
            <div className={containerClass}>
                {hasOriginal && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">{t('diffView.image.original')}</span>
                        <StatusImage
                            src={diff.original}
                            alt={t('diffView.image.originalAlt', { path: filePath })}
                            variant="large"
                            className="flex min-h-40 min-w-40 max-w-full items-center justify-center"
                            imgClassName={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            imgStyle={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
                {hasModified && (
                    <div className={imageContainerClass}>
                        <span className="typography-meta text-muted-foreground font-medium">
                            {hasOriginal ? t('diffView.image.modified') : t('diffView.image.new')}
                        </span>
                        <StatusImage
                            src={diff.modified}
                            alt={t('diffView.image.modifiedAlt', { path: filePath })}
                            variant="large"
                            className="flex min-h-40 min-w-40 max-w-full items-center justify-center"
                            imgClassName={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
                            imgStyle={{ imageRendering: 'auto' }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
});

interface InlineDiffViewerProps {
  filePath: string;
  diff: DiffData;
  commentOrigin?: DiffCommentOrigin;
  staged: boolean;
  renderSideBySide: boolean;
  wrapLines: boolean;
  hideWhitespace: boolean;
  hunkActions?: DiffHunkActions;
  onExpandContextRequest?: (request: ContextExpansionRequest) => void;
  pendingContextExpansion?: ContextExpansionRequest | null;
  contextLoading?: boolean;
  viewerRef?: React.Ref<PierreDiffViewerHandle>;
  onFindWordRequest?: (request: DiffFindWordRequest) => void;
}

export const InlineDiffViewer: React.FC<InlineDiffViewerProps> = React.memo<InlineDiffViewerProps>(({
  filePath,
  diff,
  commentOrigin,
  staged,
  renderSideBySide,
  wrapLines,
  hideWhitespace,
  hunkActions,
  onExpandContextRequest,
  pendingContextExpansion,
  contextLoading,
  viewerRef,
  onFindWordRequest,
}) => {
  const language = React.useMemo(
    () => getLanguageFromExtension(filePath) || 'text',
    [filePath]
  );

  if (diff.submodule) {
    return <SubmoduleDiffSummary state={diff.submodule} staged={staged} />;
  }

  if (diff.isBinary) {
    return <BinaryDiffPlaceholder />;
  }

  if (isOfficePreviewFile(filePath) && isDocumentVersions(diff.original, diff.modified)) {
    return (
      <OfficeDocumentDiff
        filePath={filePath}
        original={diff.original}
        modified={diff.modified}
        renderText={(text) => (
          <InlineDiffViewer
            filePath={filePath}
            diff={{ ...diff, original: text.original, modified: text.modified }}
            commentOrigin={commentOrigin}
            staged={staged}
            renderSideBySide={renderSideBySide}
            wrapLines={wrapLines}
            hideWhitespace={hideWhitespace}
          />
        )}
      />
    );
  }

  if (isImageFile(filePath)) {
    return (
            <InlineImageDiffViewer
                filePath={filePath}
                diff={diff}
                renderSideBySide={renderSideBySide}
            />
    );
  }

  return (
    <div className="w-full" style={{ contain: 'layout' }}>
      <PierreDiffViewer
        ref={viewerRef}
        original={diff.original}
        modified={diff.modified}
        fileDiff={diff.fileDiff}
        language={language}
        fileName={filePath}
        commentOrigin={commentOrigin}
        renderSideBySide={renderSideBySide}
        wrapLines={wrapLines}
        hideWhitespace={hideWhitespace}
        layout="inline"
        hunkActions={hunkActions}
        onExpandContextRequest={onExpandContextRequest}
        pendingContextExpansion={pendingContextExpansion}
        contextLoading={contextLoading}
        onFindWordRequest={onFindWordRequest}
      />
    </div>
  );
});
