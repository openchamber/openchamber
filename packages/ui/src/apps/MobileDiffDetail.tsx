import React from 'react';

import { useWholeFileComment } from '@/components/comments';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS, MOBILE_HEADER_TITLE_CLASS } from '@/components/ui/mobileHeader';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { OfficeDocumentDiff } from '@/components/views/files/OfficeDocumentDiff';
import { isDocumentVersions } from '@/components/views/files/documentVersions';
import { PierreDiffViewer, type ContextExpansionRequest, type PierreDiffViewerHandle } from '@/components/views/PierreDiffViewer';
import { SubmoduleDiffSummary } from '@/components/views/SubmoduleDiffSummary';
import { useI18n } from '@/lib/i18n';
import { useGitCleanLine } from '@/components/views/git/useGitCleanLine';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import type { GitSubmoduleState } from '@/lib/api/types';
import { useScrollToLineTarget } from '@/lib/timing/useScrollToLineTarget';
import { cn } from '@/lib/utils';
import { getLanguageFromExtension, isImageFile, isOfficePreviewFile } from '@/lib/toolHelpers';
import type { FileDiffMetadata } from '@pierre/diffs';

export interface MobileDiffData {
  original: string;
  modified: string;
  isBinary?: boolean;
  fileDiff?: FileDiffMetadata;
  submodule?: GitSubmoduleState | null;
}

export type ComparisonDiff =
  | { status: 'loading' }
  | { status: 'ready'; diff: MobileDiffData }
  | { status: 'error'; message: string };

export const MobileChangesState: React.FC<{
  message: string;
  description?: string;
  loading?: boolean;
  icon?: boolean;
}> = ({ message, description, loading = false, icon = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <Icon name="git-branch" className="size-6 text-muted-foreground" /> : null}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
      {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    </div>
  </div>
);

export const MobileCleanState: React.FC = () => {
  const { t } = useI18n();
  const description = useGitCleanLine(t('mobile.changes.cleanDescription'));
  return <MobileChangesState icon message={t('gitView.empty.cleanTitle')} description={description} />;
};

export const MobileDiffDetail: React.FC<{
  path: string;
  previousPath?: string;
  subtitle?: string;
  diff: MobileDiffData | null;
  staged?: boolean;
  fileExists: boolean;
  unavailableReason?: 'nested_repository' | 'untracked_directory' | null;
  error?: string | null;
  onBack: () => void;
  onRetry?: () => void;
  onExpandContextRequest?: (request: ContextExpansionRequest) => void;
  pendingContextExpansion?: ContextExpansionRequest | null;
  contextLoading?: boolean;
  commentOrigin?: DiffCommentOrigin;
  targetLine?: { line: number; side: 'additions' | 'deletions'; nonce: number } | null;
  onTargetReached?: () => void;
}> = ({ path, previousPath, subtitle, diff, staged = false, fileExists, unavailableReason = null, error = null, onBack, onRetry, onExpandContextRequest, pendingContextExpansion, contextLoading, commentOrigin, targetLine = null, onTargetReached }) => {
  const { t } = useI18n();
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);
  const wholeFileComment = useWholeFileComment({ fileLabel: path, origin: commentOrigin });
  const viewerRef = React.useRef<PierreDiffViewerHandle | null>(null);
  useScrollToLineTarget({ viewerRef, target: targetLine, revision: diff, onReached: onTargetReached });
  const trimmedPath = path.replace(/\/$/, '');
  const lastSlash = trimmedPath.lastIndexOf('/');
  const fileName = trimmedPath.slice(lastSlash + 1);
  const folder = lastSlash > 0 ? trimmedPath.slice(0, lastSlash) : null;
  const location = previousPath ? `${previousPath} → ${folder ?? fileName}` : folder;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className={cn(MOBILE_HEADER_CLASS, 'border-b border-edge text-foreground')}>
        <button
          type="button"
          className={MOBILE_HEADER_BUTTON_CLASS}
          aria-label={t('header.actions.backAria')}
          onClick={onBack}
        >
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-1" title={previousPath ? `${previousPath} → ${path}` : path}>
          <h2 dir="ltr" className={cn('oc-ui-start-align truncate', MOBILE_HEADER_TITLE_CLASS)}>{fileName}</h2>
          <p className="flex min-w-0 items-baseline gap-1.5 typography-micro text-muted-foreground">
            {location ? <span dir="ltr" className="oc-ui-start-align min-w-0 truncate">{location}</span> : null}
            {location && subtitle ? <span aria-hidden className="shrink-0 opacity-60">·</span> : null}
            {subtitle ? <span className="min-w-0 max-w-full shrink-0 truncate">{subtitle}</span> : null}
          </p>
        </div>
        <button
          type="button"
          className={cn(
            MOBILE_HEADER_BUTTON_CLASS,
            wholeFileComment.isOpen ? 'text-foreground' : 'text-muted-foreground',
          )}
          aria-label={t('inlineComment.actions.commentOnFile')}
          aria-pressed={wholeFileComment.isOpen}
          title={t('inlineComment.actions.commentOnFile')}
          onClick={wholeFileComment.toggle}
        >
          <Icon name="chat-1" className="size-5" />
        </button>
      </header>
      {wholeFileComment.cards}
      {wholeFileComment.editor}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!fileExists ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.missingTitle')} description={t('mobile.changes.diffDetail.missingDescription')} />
        ) : unavailableReason === 'nested_repository' ? (
          <MobileChangesState icon message={t('diffView.unavailable.nestedRepositoryTitle')} description={t('diffView.unavailable.nestedRepositoryDescription')} />
        ) : unavailableReason === 'untracked_directory' ? (
          <MobileChangesState icon message={t('diffView.unavailable.untrackedDirectoryTitle')} description={t('diffView.unavailable.untrackedDirectoryDescription')} />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">{t('mobile.changes.diffDetail.loadFailed')}</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => onRetry?.()}>{t('diffView.actions.retry')}</Button>
            </div>
          </div>
        ) : !diff ? (
          <MobileChangesState loading message={t('diffView.state.loadingDiff')} />
        ) : diff.submodule ? (
          <div className="p-3"><SubmoduleDiffSummary state={diff.submodule} staged={staged} /></div>
        ) : diff.isBinary ? (
          <MobileChangesState icon message={t('diffView.binary.unavailable')} />
        ) : isOfficePreviewFile(path) && isDocumentVersions(diff.original, diff.modified) ? (
          <ScrollableOverlay outerClassName="h-full" className="p-3" disableHorizontal data-diff-virtual-root data-diff-virtual-content>
            <OfficeDocumentDiff
              filePath={path}
              original={diff.original}
              modified={diff.modified}
              renderText={(text) => (
                <PierreDiffViewer
                  original={text.original}
                  modified={text.modified}
                  language="text"
                  fileName={path}
                  commentOrigin={commentOrigin}
                  ref={viewerRef}
                  renderSideBySide={false}
                  wrapLines={true}
                  layout="inline"
                />
              )}
            />
          </ScrollableOverlay>
        ) : previousPath && (diff.fileDiff ? diff.fileDiff.hunks.length === 0 : diff.original === diff.modified) ? (
          <MobileChangesState icon message={t('diffView.change.renamedFrom', { from: previousPath })} />
        ) : isImageFile(path) && !diff.fileDiff ? (
          <MobileChangesState icon message={t('mobile.changes.diffDetail.imageUnavailable')} />
        ) : (
          <ScrollableOverlay
            outerClassName="h-full"
            className="p-3"
            useScrollShadow
            disableHorizontal
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original={diff.original}
              modified={diff.modified}
              fileDiff={diff.fileDiff}
              language={language}
              fileName={path}
              commentOrigin={commentOrigin}
              ref={viewerRef}
              renderSideBySide={false}
              wrapLines={true}
              layout="inline"
              onExpandContextRequest={onExpandContextRequest}
              pendingContextExpansion={pendingContextExpansion}
              contextLoading={contextLoading}
            />
          </ScrollableOverlay>
        )}
      </div>
    </div>
  );
};
