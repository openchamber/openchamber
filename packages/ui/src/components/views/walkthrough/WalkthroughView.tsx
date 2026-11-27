import { Popover } from '@base-ui/react/popover';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { ReviewSubmitButton } from '@/components/review/ReviewSubmitButton';
import { ChangeRequestReviewContext, useComparisonReview } from '@/components/review/useChangeRequestReview';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestDiffServing, useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import { ChangeRequestDiffUnavailable } from '@/components/views/git/ChangeRequestDiffUnavailable';
import type { WalkthroughSource, WalkthroughTarget, WalkthroughWorkingTreeScope } from '@/lib/walkthrough/types';
import { useBranchComparisonBase } from '@/hooks/useBranchComparisonBase';
import { useBranchPullRequestRequest } from '@/hooks/useBranchPullRequestRequest';
import { useCommitComparison } from '@/hooks/useCommitComparison';
import { usePullRequestComparison } from '@/hooks/usePullRequestComparison';
import { PullRequestComparisonSelector } from '@/components/views/git/PullRequestComparisonSelector';
import { CommitComparisonSelector } from '@/components/views/git/CommitComparisonSelector';
import { BranchComparisonSelector } from '@/components/views/git/BranchComparisonSelector';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { gitPushScopeKey, subscribeGitPush } from '@/lib/gitPushEvents';
import { useGitBranches, useGitStatus, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { cn } from '@/lib/utils';
import { DiffFindBar } from '@/components/views/diffFind/DiffFindBar';
import { useWalkthroughFind } from './useWalkthroughFind';
import { WalkthroughBlocker } from './WalkthroughBlocker';
import { WalkthroughStages } from './WalkthroughStages';
import { WalkthroughStream } from './WalkthroughStream';
import { WalkthroughToc } from './WalkthroughToc';
import {
  WalkthroughBanners,
  WalkthroughEmptyState,
  WalkthroughGenerateButton,
  WalkthroughLanguagePicker,
  WalkthroughModelPicker,
  WalkthroughExportMenu,
  WalkthroughOptions,
  WalkthroughStepMenu,
} from './WalkthroughControls';
import { MENU_GROUP_LABEL_CLASS, openWalkthroughGuide } from './walkthroughAction';
import { useWalkthroughReview } from './useWalkthroughReview';
import { useWalkthroughReviewedFiles } from './useWalkthroughReviewedFiles';
import { useToolbarFit } from '@/components/views/useDiffToolbarFit';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { NestedRepoResolutionStates } from '@/components/views/git/NestedRepoResolutionStates';
import { GitRepositoryUnreadableState } from '@/components/views/git/GitRepositoryUnreadableState';
import { NestedRepoPicker } from '@/components/views/git/NestedRepoPicker';
import { revisionSuffix } from '@/lib/diff/pullRequestDiff';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { diffCommentOriginFromTarget } from '@/lib/diffCommentOrigin';

interface WalkthroughViewProps {
  directory: string;
  visible?: boolean;
}

const SCOPES: WalkthroughWorkingTreeScope[] = ['all', 'staged', 'working'];

const TOC_MIN_PANEL_WIDTH = 720;
const TOC_MIN_WIDTH = 180;
const TOC_MAX_FRACTION = 0.5;

const WALKTHROUGH_HEADER_FIT = {
  steps: [
    'data-walkthrough-header-compact',
    'data-walkthrough-header-tight',
    'data-walkthrough-header-minimal',
    'data-walkthrough-header-narrow',
  ],
} as const;

export const WalkthroughView = ({ directory: rootDirectory, visible = true }: WalkthroughViewProps) => {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inPanelHeader = useInContextPanelHeader();
  const [panelWidth, setPanelWidth] = useState(0);

  const { rootIsGitRepo, gitDirectory, nestedRepos, repositoryOptions, unreadable } = useNestedGitDirectory(rootDirectory || null, { enabled: visible, recheckOnOpen: true });
  const directory = gitDirectory ?? rootDirectory;

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      setPanelWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const headerRef = useRef<HTMLElement | null>(null);
  useToolbarFit(headerRef, WALKTHROUGH_HEADER_FIT);

  const storedTocWidth = useUIStore((state) => state.walkthroughTocWidth);
  const setStoredTocWidth = useUIStore((state) => state.setWalkthroughTocWidth);
  const [draggingToc, setDraggingToc] = useState(false);

  const showToc = panelWidth === 0 || panelWidth >= TOC_MIN_PANEL_WIDTH;
  const tocWidth = Math.min(
    Math.max(storedTocWidth, TOC_MIN_WIDTH),
    Math.max(TOC_MIN_WIDTH, (panelWidth || TOC_MIN_PANEL_WIDTH) * TOC_MAX_FRACTION)
  );

  const handleTocResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = tocWidth;
      const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
      const maxWidth = Math.max(TOC_MIN_WIDTH, (rootRef.current?.clientWidth ?? 0) * TOC_MAX_FRACTION);
      setDraggingToc(true);

      const onMove = (moveEvent: PointerEvent) => {
        const next = Math.min(maxWidth, Math.max(TOC_MIN_WIDTH, startWidth + (moveEvent.clientX - startX) * sign));
        setStoredTocWidth(next);
      };
      const onUp = () => {
        setDraggingToc(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [setStoredTocWidth, tocWidth]
  );

  const handleTocResizeKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 10;
      const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
      const delta = (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) * sign;
      if (delta === 0) return;
      event.preventDefault();
      const maxWidth = Math.max(TOC_MIN_WIDTH, (rootRef.current?.clientWidth ?? 0) * TOC_MAX_FRACTION);
      setStoredTocWidth(Math.min(maxWidth, Math.max(TOC_MIN_WIDTH, tocWidth + delta)));
    },
    [setStoredTocWidth, tocWidth]
  );
  const [scope, setScope] = useState<WalkthroughWorkingTreeScope>('all');
  const [pendingSourceSelection, setPendingSourceSelection] = useState<{ directory: string; kind: 'branch' | 'commit' | 'pr' } | null>(null);

  const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
  const wrapLines = useUIStore((state) => state.diffWrapLines);
  const renderSideBySide = diffLayoutPreference === 'side-by-side';

  const requestedTarget = useWalkthroughStore((state) => state.getRequestedTarget(directory));
  const clearRequestedTarget = useWalkthroughStore((state) => state.clearRequestedTarget);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const panelDirectory = useEffectiveDirectory() ?? rootDirectory;

  const status = useGitStatus(directory || null);
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const [pushRevision, setPushRevision] = useState(0);
  useEffect(() => subscribeGitPush((scope) => {
    if (scope === gitPushScopeKey(directory, runtimeKey)) setPushRevision((value) => value + 1);
  }), [directory, runtimeKey]);
  const branches = useGitBranches(directory || null);
  const setBaseOverride = useGitBaseBranchStore((state) => state.setOverride);
  const clearBaseOverride = useGitBaseBranchStore((state) => state.clearOverride);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const { sourceControl, git } = useRuntimeAPIs();
  const binding = useRepositoryBinding(directory, sourceControl);

  useEffect(() => {
    if (visible && directory) void ensureAll(directory, git);
  }, [directory, ensureAll, git, visible]);

  const currentBranch = status?.current ?? null;
  const choosingCommit = pendingSourceSelection?.directory === directory && pendingSourceSelection.kind === 'commit' && !requestedTarget;
  const isCommitScope = choosingCommit || requestedTarget?.source.kind === 'commit';
  const requestedCommitHash = requestedTarget?.source.kind === 'commit' ? requestedTarget.source.hash : undefined;
  const commitComparison = useCommitComparison(directory || null, currentBranch, visible && isCommitScope, requestedCommitHash);
  const selectedCommitHash = commitComparison.selectedCommit?.hash ?? requestedCommitHash ?? null;
  const remoteNames = useMemo(
    () => new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
    [binding.read],
  );
  const { base: comparisonBase, source: comparisonBaseSource, resolved: comparisonBaseResolved, revision: branchRevision } =
    useBranchComparisonBase(directory || null, currentBranch, visible, {
      branches, remoteNames, primaryRemote: binding.contexts[0]?.primaryRemote, readContext: binding.contexts[0] ?? null,
    });
  const branchSource = useMemo<Extract<WalkthroughSource, { kind: 'branch' }> | null>(() => (
    currentBranch && comparisonBase ? { kind: 'branch', baseRef: comparisonBase, headRef: currentBranch } : null
  ), [comparisonBase, currentBranch]);

  useBranchPullRequestRequest(directory || null, currentBranch, binding);
  const readContext = binding.contexts[0] ?? null;

  const choosingPr = pendingSourceSelection?.directory === directory && pendingSourceSelection.kind === 'pr' && !requestedTarget;
  const isPrScope = choosingPr || requestedTarget?.source.kind === 'pr';
  const prComparison = usePullRequestComparison(directory || null, currentBranch, readContext, visible && isPrScope,
    requestedTarget?.source.kind === 'pr' ? requestedTarget.source : undefined);
  const selectedPr = prComparison.selectedSource;
  const readsChangeRequests = prComparison.readContext !== null;
  const offersChangeRequests = useChangeRequestDiffServing(readContext?.provider) !== 'not-served' && readContext !== null;
  const prDiffUnavailable = isPrScope && prComparison.diffUnavailable;
  const changeRequestTerm = useChangeRequestTerm(prComparison.provider);

  const target = useMemo<WalkthroughTarget>(
    () => isPrScope && selectedPr && readsChangeRequests && readContext
      ? { source: selectedPr, context: readContext }
      : isCommitScope && selectedCommitHash
        ? { source: { kind: 'commit', hash: selectedCommitHash } }
        : requestedTarget?.source.kind === 'branch'
          ? { source: branchSource ?? requestedTarget.source }
          : requestedTarget ?? { source: { kind: 'working-tree', scope } },
    [branchSource, isCommitScope, isPrScope, readContext, readsChangeRequests, requestedTarget, scope, selectedCommitHash, selectedPr]
  );
  const source = target.source;
  const commentOrigin = useMemo(() => diffCommentOriginFromTarget(target), [target]);
  const { review: changeRequestReview, provider: reviewProvider } = useComparisonReview(prComparison, directory, visible && isPrScope);
  const choosingBranchBase = pendingSourceSelection?.directory === directory
    && pendingSourceSelection.kind === 'branch' && !requestedTarget;
  const isBranchScope = choosingBranchBase || source.kind === 'branch';
  const branchNeedsBase = choosingBranchBase || (source.kind === 'branch' && !branchSource);
  const commitNeedsSelection = choosingCommit || (isCommitScope && !selectedCommitHash);
  const prNeedsSelection = isPrScope && !selectedPr;
  const needsSourceSelection = branchNeedsBase || commitNeedsSelection || prNeedsSelection || prDiffUnavailable;

  const selectWorkingTree = useCallback(
    (value: WalkthroughWorkingTreeScope) => {
      setPendingSourceSelection(null);
      clearRequestedTarget(directory);
      setScope(value);
    },
    [clearRequestedTarget, directory]
  );
  const requestTarget = useWalkthroughStore((state) => state.requestTarget);
  useEffect(() => {
    if (!choosingPr || !selectedPr || !readsChangeRequests || !readContext) return;
    requestTarget(directory, { source: selectedPr, context: readContext });
    setPendingSourceSelection(null);
  }, [choosingPr, directory, readContext, readsChangeRequests, requestTarget, selectedPr]);
  useEffect(() => {
    if (!choosingBranchBase || !branchSource) return;
    requestTarget(directory, { source: branchSource });
    setPendingSourceSelection(null);
  }, [branchSource, choosingBranchBase, directory, requestTarget]);
  useEffect(() => {
    if (!choosingCommit || !selectedCommitHash) return;
    requestTarget(directory, { source: { kind: 'commit', hash: selectedCommitHash } });
    setPendingSourceSelection(null);
  }, [choosingCommit, directory, requestTarget, selectedCommitHash]);
  const sourceRevision = source.kind === 'branch' ? branchRevision : '';
  const prPushRevision = source.kind === 'pr' ? pushRevision : 0;
  const review = useWalkthroughReview({
    directory,
    target,
    visible,
    needsSourceSelection,
    revision: JSON.stringify([sourceRevision, prPushRevision]),
  });
  const { view } = review;
  const walkthroughState = useWalkthroughReviewedFiles({
    directory,
    source,
    result: review.entry.result,
    view,
  });

  const findInWalkthrough = useWalkthroughFind({
    view,
    renderSideBySide,
    visible,
    rootRef,
    selectStop: review.handleSelectStop,
    markStopActive: review.handleActiveStopChange,
  });
  const diffFind = findInWalkthrough.find;

  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const sourceValue = isPrScope ? 'pr' : isCommitScope ? 'commit' : isBranchScope ? 'branch' : source.kind === 'working-tree' ? source.scope : source.kind;
  const sourceLabel = isPrScope ? t(changeRequestCopy('session.githubIntegration.tabs.pullRequests', changeRequestTerm)) : isCommitScope ? t('commitComparison.mode') : isBranchScope
    ? t('walkthrough.scope.branch')
    : source.kind === 'pr'
      ? `${t(changeRequestCopy('walkthrough.scope.pullRequest', changeRequestTerm), { number: source.number })}${revisionSuffix(source)}`
      : scope === 'all'
        ? t('walkthrough.scope.all')
        : scope === 'staged'
          ? t('walkthrough.scope.staged')
          : t('walkthrough.scope.working');
  const openChanges = () => openContextPanelTab(panelDirectory, { mode: 'diff', diffScope: 'pr', targetDirectory: rootDirectory });
  const headerOffersGeneration = Boolean(view || review.blocked);
  const sourceIcon = isPrScope ? 'git-pull-request' : isCommitScope ? 'git-commit' : isBranchScope ? 'git-branch' : 'file-edit';

  const isGitRepo = useIsGitRepo(gitDirectory || null);
  const ensureNestedRepos = useGitStore((state) => state.ensureNestedRepos);
  const selectNestedRepo = useGitStore((state) => state.selectNestedRepo);
  if (unreadable) {
    return <GitRepositoryUnreadableState directory={unreadable.directory} message={unreadable.message} />;
  }
  if (rootIsGitRepo === false && isGitRepo !== true) {
    return (
      <NestedRepoResolutionStates
        root={rootDirectory}
        rootIsGitRepo={rootIsGitRepo}
        resolvedIsGitRepo={isGitRepo}
        nestedRepos={nestedRepos}
        onRetryDiscovery={() => {
          if (rootDirectory) void ensureNestedRepos(rootDirectory, { force: true });
        }}
      />
    );
  }

  return (
    <ChangeRequestReviewContext.Provider value={changeRequestReview}>
    <div ref={rootRef} data-find-surface="" className="flex h-full min-h-0 flex-col">
      <ContextPanelHeaderToolbar>
      <header
        ref={headerRef}
        className={cn(
          'walkthrough-header flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden',
          inPanelHeader ? 'flex-1 py-1 pe-1' : 'shrink-0 border-b border-edge px-3 py-2'
        )}
      >
        {repositoryOptions ? (
          <div className="shrink-0">
            <NestedRepoPicker
              repositories={repositoryOptions}
              selectedRepository={gitDirectory ?? null}
              onSelectRepository={(repository) => {
                if (rootDirectory) selectNestedRepo(rootDirectory, repository);
              }}
              repositoryRoot={rootDirectory ?? undefined}
            />
          </div>
        ) : null}
        <DropdownMenu open={sourceMenuOpen} onOpenChange={setSourceMenuOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(dropdownTriggerVariants(), 'shrink-0')}
                    aria-label={t('walkthrough.scope.selectorAria')}
                  >
                    <Icon name={sourceIcon} className="walkthrough-header__source-icon" />
                    <span className="walkthrough-header__source-label">{sourceLabel}</span>
                    <Icon name="arrow-down-s" />
                  </button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('walkthrough.scope.selectorAria')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup
              value={sourceValue}
              onValueChange={(value) => {
                setSourceMenuOpen(false);
                if (value === 'commit') {
                  clearRequestedTarget(directory);
                  setPendingSourceSelection({ directory, kind: 'commit' });
                  return;
                }
                if (value === 'branch') {
                  if (branchSource) {
                    setPendingSourceSelection(null);
                    requestTarget(directory, { source: branchSource });
                  } else {
                    clearRequestedTarget(directory);
                    setPendingSourceSelection({ directory, kind: 'branch' });
                  }
                  return;
                }
                if (value === 'pr') {
                  clearRequestedTarget(directory);
                  setPendingSourceSelection({ directory, kind: 'pr' });
                  return;
                }
                selectWorkingTree(value as WalkthroughWorkingTreeScope);
              }}
            >
              <DropdownMenuLabel className={MENU_GROUP_LABEL_CLASS}>
                {t('walkthrough.scope.group.workingTree')}
              </DropdownMenuLabel>
              {SCOPES.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {value === 'all'
                    ? t('walkthrough.scope.all')
                    : value === 'staged'
                      ? t('walkthrough.scope.staged')
                      : t('walkthrough.scope.working')}
                </DropdownMenuRadioItem>
              ))}
              {currentBranch && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioItem value="branch">
                    {t('walkthrough.scope.branch')}
                  </DropdownMenuRadioItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuRadioItem value="commit">
                {t('commitComparison.mode')}
              </DropdownMenuRadioItem>
              {offersChangeRequests && (
                <DropdownMenuRadioItem value="pr">
                  {t(changeRequestCopy('session.githubIntegration.tabs.pullRequests', changeRequestTerm))}
                </DropdownMenuRadioItem>
              )}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {isBranchScope && (
          <div className="min-w-0 shrink">
            <BranchComparisonSelector
              key={JSON.stringify([directory, currentBranch])}
              branches={branches?.all ?? []}
              defaultBranches={branches?.defaultBranches}
              primaryRemote={binding.contexts[0]?.primaryRemote}
              currentBranch={currentBranch}
              base={comparisonBase}
              automatic={comparisonBaseSource !== 'chosen'}
              onSelect={(base) => {
                if (directory && currentBranch) setBaseOverride(directory, currentBranch, base);
              }}
              onSelectAutomatic={() => {
                if (directory && currentBranch) clearBaseOverride(directory, currentBranch);
              }}
            />
          </div>
        )}

        {isCommitScope && (
          <div className="min-w-0 shrink">
            <CommitComparisonSelector
              key={JSON.stringify([directory, currentBranch])}
              commits={commitComparison.commits}
              selectedHash={selectedCommitHash}
              loading={commitComparison.loading}
              error={commitComparison.error}
              onSelect={commitComparison.select}
              onRefresh={() => void commitComparison.refresh()}
            />
          </div>
        )}
        {isPrScope && !prDiffUnavailable && (
          <div className="min-w-0 shrink">
            <PullRequestComparisonSelector key={JSON.stringify([directory, currentBranch])} comparison={prComparison} />
          </div>
        )}

        <div className="ms-auto flex shrink-0 items-center gap-1">
          {isPrScope && selectedPr && !prDiffUnavailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="walkthrough-header__option"
                  aria-label={t('contextPanel.mode.diff')}
                  onClick={openChanges}>
                  <Icon name="arrow-left-right" className="size-4" />
                  <span className="walkthrough-header__label">{t('contextPanel.mode.diff')}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.walkthrough.openChanges')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="walkthrough-header__option"
                aria-label={t('walkthrough.help.guide')}
                onClick={openWalkthroughGuide}
              >
                <Icon name="question" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="typography-micro leading-tight">{t('walkthrough.help.guide')}</p>
            </TooltipContent>
          </Tooltip>

          <WalkthroughExportMenu review={review} className="walkthrough-header__option" />
          {headerOffersGeneration && (
            <>
              <WalkthroughLanguagePicker review={review} className="walkthrough-header__option max-w-40" />
              <WalkthroughModelPicker review={review} className="walkthrough-header__option walkthrough-header__model h-7 min-w-0 max-w-48" />
            </>
          )}
          {view && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="walkthrough-header__step-arrow"
                    aria-label={t('walkthrough.action.previous')}
                    onClick={() => review.step(-1)}
                  >
                    <Icon name="arrow-right-s" className="size-4 rotate-180" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>{t('walkthrough.action.previous')}</TooltipContent>
              </Tooltip>
              {!showToc && <WalkthroughStepMenu review={review} view={view} />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="walkthrough-header__step-arrow"
                    aria-label={t('walkthrough.action.next')}
                    onClick={() => review.step(1)}
                  >
                    <Icon name="arrow-right-s" className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>{t('walkthrough.action.next')}</TooltipContent>
              </Tooltip>
            </>
          )}

          {changeRequestReview && reviewProvider ? (
            <ReviewSubmitButton review={changeRequestReview} provider={reviewProvider} labelClassName="walkthrough-header__label" />
          ) : null}
          {!prDiffUnavailable && (headerOffersGeneration || review.isGenerating) && (
            <WalkthroughGenerateButton
              review={review}
              hasView={Boolean(view)}
              className="walkthrough-header__generate"
              labelClassName="walkthrough-header__label"
            />
          )}
          <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
            <Tooltip disabled={moreOpen}>
              <TooltipTrigger asChild>
                <Popover.Trigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="walkthrough-header__more data-[popup-open]:bg-interactive-hover"
                      aria-label={t('walkthrough.options.moreAria')}
                    />
                  }
                >
                  <Icon name="more" className="size-4" />
                </Popover.Trigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{t('walkthrough.options.moreAria')}</TooltipContent>
            </Tooltip>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
                <Popover.Popup
                  aria-label={t('walkthrough.options.title')}
                  className={cn(dropdownMenuPopupClass, 'w-64 max-w-[calc(100vw-2rem)] p-3')}
                >
                  <WalkthroughOptions
                    review={review}
                    hasView={Boolean(view)}
                    onOpenChanges={isPrScope && selectedPr ? openChanges : undefined}
                    allStopsCollapsed={walkthroughState.allStopsCollapsed}
                    onToggleAllStopsCollapsed={walkthroughState.toggleAllStopsCollapsed}
                    onActed={() => setMoreOpen(false)}
                  />
                  <GlassRedrawGuard />
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </header>
      </ContextPanelHeaderToolbar>

      {!prDiffUnavailable && <WalkthroughBanners review={review} view={view} />}

      <div className={cn('flex min-h-0 flex-1', showToc ? 'flex-row' : 'flex-col')}>
        {prDiffUnavailable ? (
          <ChangeRequestDiffUnavailable provider={prComparison.provider} className="p-8" />
        ) : prNeedsSelection ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            {!prComparison.error && !prComparison.loading && <Icon name="git-pull-request" className="size-6 text-muted-foreground" />}
            <p className="typography-meta text-muted-foreground">{prComparison.error ?? (prComparison.loading
              ? t(changeRequestCopy('session.githubPrPicker.loading.pullRequests', changeRequestTerm))
              : t(changeRequestCopy('pullRequestComparison.pickAbove', changeRequestTerm)))}</p>
          </div>
        ) : commitNeedsSelection ? (
          <div className="flex flex-1 items-center justify-center gap-2 p-8 typography-meta text-muted-foreground">
            {commitComparison.loading ? <Icon name="loader-4" className="size-6 animate-spin" />
              : commitComparison.error ?? t('commitComparison.noCommits')}
          </div>
        ) : branchNeedsBase ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            {!comparisonBaseResolved && currentBranch ? (
              <Icon name="loader-4" className="size-6 animate-spin text-muted-foreground" />
            ) : (
              <p className="typography-meta text-muted-foreground">
                {t('gitView.pr.toast.baseBranchRequired')}
              </p>
            )}
          </div>
        ) : review.blocked ? (
          <WalkthroughBlocker
            reason={review.blocked.reason}
            model={review.blocked.model}
            requiredChars={review.blocked.requiredChars}
            availableChars={review.blocked.availableChars}
            onRetry={review.retry}
            onModelSaved={review.switchToSavedModel}
          />
        ) : review.showStages ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
            <WalkthroughStages progress={review.stageProgress} />
          </div>
        ) : view ? (
          <>
            {showToc && (
              <>
                <WalkthroughToc
                  view={view}
                  activeStopId={review.activeStopId}
                  visitedStopIds={review.visitedStopIds}
                  reviewedPaths={walkthroughState.reviewedPaths}
                  totalFileCount={walkthroughState.totalFileCount}
                  onSelectStop={review.handleSelectStop}
                  width={tocWidth}
                />
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('walkthrough.toc.resize')}
                  tabIndex={0}
                  onPointerDown={handleTocResizeStart}
                  onKeyDown={handleTocResizeKey}
                  className={cn(
                    'group relative w-1 shrink-0 cursor-col-resize',
                    'before:absolute before:inset-y-0 before:-inset-s-1 before:-inset-e-1 before:content-[\'\']',
                    'hover:bg-interactive-selection focus-visible:bg-interactive-selection focus-visible:outline-none',
                    draggingToc && 'bg-interactive-selection'
                  )}
                />
              </>
            )}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {diffFind.isOpen && (
                <DiffFindBar
                  query={diffFind.query}
                  onQueryChange={diffFind.setQuery}
                  total={diffFind.matches.length}
                  currentIndex={diffFind.currentIndex}
                  isSearching={diffFind.isSearching}
                  failedCount={diffFind.failedCount}
                  onNext={diffFind.next}
                  onPrevious={diffFind.previous}
                  onClose={diffFind.close}
                  focusNonce={findInWalkthrough.focusNonce}
                />
              )}
              <WalkthroughStream
                view={view}
                activeStopId={review.activeStopId}
                scrollToStopId={review.scrollToStopId}
                onActiveStopChange={review.handleActiveStopChange}
                onScrollHandled={review.clearScrollRequest}
                renderSideBySide={renderSideBySide}
                wrapLines={wrapLines}
                commentOrigin={commentOrigin}
                summary={showToc ? undefined : view.walkthrough.focus}
                revealRequest={findInWalkthrough.revealRequest}
                reviewedPaths={walkthroughState.reviewedPaths}
                onToggleFileReviewed={walkthroughState.toggleFileReviewed}
                collapsedStopIds={walkthroughState.collapsedStopIds}
                onToggleStopCollapsed={walkthroughState.toggleStopCollapsed}
                onExpandStop={walkthroughState.expandStop}
                registerFindViewerRef={findInWalkthrough.registerViewer}
                onFindWordRequest={findInWalkthrough.openOnWord}
              />
            </div>
          </>
        ) : (
          <WalkthroughEmptyState review={review} />
        )}
      </div>
    </div>
    </ChangeRequestReviewContext.Provider>
  );
};
