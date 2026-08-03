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
import { useI18n, type Locale } from '@/lib/i18n';
import { buildWalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughSource, WalkthroughWorkingTreeScope } from '@/lib/walkthrough/types';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { deriveBaseBranch } from '@/components/views/git/baseBranch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGitBranches, useGitStatus } from '@/stores/useGitStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import {
  getFreshestPrStatusForBranch,
  getGitHubPrStatusKey,
  useGitHubPrStatusStore,
} from '@/stores/useGitHubPrStatusStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { cn } from '@/lib/utils';
import { WalkthroughBlocker } from './WalkthroughBlocker';
import { WALKTHROUGH_ACTION_CLASS } from './walkthroughAction';
import { WalkthroughStages } from './WalkthroughStages';
import { useWalkthroughStageProgress } from './useWalkthroughStageProgress';
import { WalkthroughStream } from './WalkthroughStream';
import { WalkthroughToc } from './WalkthroughToc';

interface WalkthroughViewProps {
  directory: string;
}

const SCOPES: WalkthroughWorkingTreeScope[] = ['all', 'staged', 'working'];

// DropdownMenuLabel defaults to the same size and weight as its items, which
// makes a heading read as another choice. This matches SelectLabel, the
// treatment used by the worktree picker.
const SCOPE_GROUP_LABEL_CLASS = 'typography-meta font-normal text-muted-foreground';

// Below this the table of contents would squeeze the diff into uselessness, so
// the stream takes the whole panel and the header arrows carry navigation.
const TOC_MIN_PANEL_WIDTH = 720;
const TOC_MIN_WIDTH = 180;
// The diff is the point of the surface; the contents column may never take more
// than half the panel no matter how far the user drags.
const TOC_MAX_FRACTION = 0.5;

// Below this the header controls wrap onto a second row and the labels squeeze
// to two letters and an ellipsis, which reads as broken rather than dense. The
// controls drop their text instead: every one of them carries an icon that
// already identifies it.
//
// Every control in this row is 32px tall — `Button` size `sm` and the dropdown
// trigger's `default` size are both h-8, so this is the design system's form
// scale rather than a number picked here. Three heights in one row (28px
// pickers, 32px action, 36px arrows) read as misalignment, not hierarchy.
const HEADER_COMPACT_WIDTH = 680;

export const WalkthroughView = ({ directory }: WalkthroughViewProps) => {
  const { t, locale, locales, label } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);

  // Panel width, not viewport width: this surface is resizable independently of
  // the window.
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      setPanelWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const storedTocWidth = useUIStore((state) => state.walkthroughTocWidth);
  const setStoredTocWidth = useUIStore((state) => state.setWalkthroughTocWidth);
  const [draggingToc, setDraggingToc] = useState(false);

  const showToc = panelWidth === 0 || panelWidth >= TOC_MIN_PANEL_WIDTH;
  // Zero means the observer has not reported yet; assume there is room rather
  // than rendering a compact header for one frame on every open.
  const compactHeader = panelWidth > 0 && panelWidth < HEADER_COMPACT_WIDTH;
  // Clamped on read rather than on write: the panel can be resized after the
  // width was stored, and a remembered 400px column must not swallow a narrow
  // panel.
  const tocWidth = Math.min(
    Math.max(storedTocWidth, TOC_MIN_WIDTH),
    Math.max(TOC_MIN_WIDTH, (panelWidth || TOC_MIN_PANEL_WIDTH) * TOC_MAX_FRACTION)
  );

  const handleTocResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = tocWidth;
      const maxWidth = Math.max(TOC_MIN_WIDTH, (rootRef.current?.clientWidth ?? 0) * TOC_MAX_FRACTION);
      setDraggingToc(true);

      const onMove = (moveEvent: PointerEvent) => {
        const next = Math.min(maxWidth, Math.max(TOC_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
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
      const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      if (delta === 0) return;
      event.preventDefault();
      const maxWidth = Math.max(TOC_MIN_WIDTH, (rootRef.current?.clientWidth ?? 0) * TOC_MAX_FRACTION);
      setStoredTocWidth(Math.min(maxWidth, Math.max(TOC_MIN_WIDTH, tocWidth + delta)));
    },
    [setStoredTocWidth, tocWidth]
  );
  const [scope, setScope] = useState<WalkthroughWorkingTreeScope>('all');
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [scrollToStopId, setScrollToStopId] = useState<string | null>(null);
  const [visitedStopIds, setVisitedStopIds] = useState<ReadonlySet<string>>(() => new Set());

  const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
  const wrapLines = useUIStore((state) => state.diffWrapLines);
  // The walkthrough column is narrower than the diff surface and stops are read
  // top-to-bottom, so `dynamic` resolves to inline here rather than guessing
  // from the window width.
  const renderSideBySide = diffLayoutPreference === 'side-by-side';

  const requestedSource = useWalkthroughStore((state) => state.requestedSource[directory]);
  const clearRequestedSource = useWalkthroughStore((state) => state.clearRequestedSource);

  const status = useGitStatus(directory || null);
  const branches = useGitBranches(directory || null);

  // The branch source reviews everything on this branch that is not on its
  // base. Three-dot semantics server-side mean merges from the base are
  // already excluded.
  const currentBranch = status?.current ?? null;
  const branchSource = useMemo<WalkthroughSource | null>(() => {
    const headRef = currentBranch;
    if (!headRef) return null;
    const all = branches?.all ?? [];
    const localBranches = all.filter((name) => !name.startsWith('remotes/'));
    const remoteNames = new Set(
      all
        .filter((name) => name.startsWith('remotes/'))
        .map((name) => name.slice('remotes/'.length).split('/')[0])
        .filter(Boolean)
    );
    const baseRef = deriveBaseBranch({ remoteNames, localBranches });
    if (!baseRef || baseRef === headRef) return null;
    return { kind: 'branch', baseRef, headRef };
  }, [branches, currentBranch]);

  // The pull request for this branch used to appear only after visiting the PR
  // panel, because nothing else asked GitHub about it. Ask here too: the status
  // store already dedupes by signature and throttles by TTL, so several panels
  // wanting the same answer produce one request.
  const { github } = useRuntimeAPIs();
  const githubConnected = useGitHubAuthStore((state) => state.status?.connected ?? false);
  const githubAuthChecked = useGitHubAuthStore((state) => state.hasChecked);
  const ensurePrStatusEntry = useGitHubPrStatusStore((state) => state.ensureEntry);
  const setPrStatusParams = useGitHubPrStatusStore((state) => state.setParams);
  const refreshPrStatusTargets = useGitHubPrStatusStore((state) => state.refreshTargets);

  useEffect(() => {
    if (!directory || !currentBranch || !githubAuthChecked || !githubConnected) return;
    const key = getGitHubPrStatusKey(directory, currentBranch);
    ensurePrStatusEntry(key);
    setPrStatusParams(key, {
      directory,
      branch: currentBranch,
      remoteName: null,
      canShow: true,
      github,
      githubAuthChecked,
      githubConnected,
    });
    void refreshPrStatusTargets([{ directory, branch: currentBranch, remoteName: null }]);
  }, [
    currentBranch,
    directory,
    ensurePrStatusEntry,
    github,
    githubAuthChecked,
    githubConnected,
    refreshPrStatusTargets,
    setPrStatusParams,
  ]);

  // Selecting the number rather than the entry map: a primitive keeps this
  // panel out of every unrelated PR status update.
  const branchPrNumber = useGitHubPrStatusStore((state) => (
    directory && currentBranch
      ? getFreshestPrStatusForBranch(state.entries, directory, currentBranch)?.pr?.number ?? null
      : null
  ));

  const source = useMemo<WalkthroughSource>(
    () => requestedSource ?? { kind: 'working-tree', scope },
    [requestedSource, scope]
  );

  // Offer whichever pull request we know about: the one already selected, or
  // the one this branch has.
  const prSource = useMemo<Extract<WalkthroughSource, { kind: 'pr' }> | null>(() => {
    if (source.kind === 'pr') return source;
    return branchPrNumber ? { kind: 'pr', number: branchPrNumber } : null;
  }, [branchPrNumber, source]);

  const selectWorkingTree = useCallback(
    (value: WalkthroughWorkingTreeScope) => {
      clearRequestedSource(directory);
      setScope(value);
    },
    [clearRequestedSource, directory]
  );
  const entry = useWalkthroughStore((state) => state.getEntry(directory, source));
  const load = useWalkthroughStore((state) => state.load);
  const generate = useWalkthroughStore((state) => state.generate);
  const cancel = useWalkthroughStore((state) => state.cancel);
  const requestSource = useWalkthroughStore((state) => state.requestSource);
  const selectModel = useWalkthroughStore((state) => state.selectModel);
  const selectedModel = useWalkthroughStore((state) => state.getSelectedModel(directory, source));
  const selectLanguage = useWalkthroughStore((state) => state.selectLanguage);
  const selectedLanguage = useWalkthroughStore((state) => state.getSelectedLanguage(directory, source));

  // Explicit pick first, then the language the walkthrough on screen is
  // actually written in, then the interface locale. The middle step matters for
  // the same reason it does for the model: reopening a review should describe
  // what is there, not what a fresh one would be.
  const generatedLanguage = entry.result?.language;
  const activeLanguage: Locale = (
    selectedLanguage && locales.includes(selectedLanguage as Locale)
      ? (selectedLanguage as Locale)
      : generatedLanguage && locales.includes(generatedLanguage as Locale)
        ? (generatedLanguage as Locale)
        : locale
  );

  // Reloads on a model or language change: whether this diff fits, and whether
  // the model can produce structured output, are answers about a specific
  // request — and the language instruction is part of that request.
  useEffect(() => {
    void load(directory, source, { language: activeLanguage });
  }, [activeLanguage, directory, load, source, selectedModel]);

  const view = useMemo(() => buildWalkthroughView(entry.result), [entry.result]);

  // A new walkthrough is a new reading path: keeping the old progress would
  // mark stops as visited that the user has never seen.
  const generatedAt = entry.result?.generatedAt;
  const lastGeneratedAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastGeneratedAt.current === generatedAt) return;
    lastGeneratedAt.current = generatedAt;
    setVisitedStopIds(new Set());
    setActiveStopId(view?.stops[0]?.stop.id ?? null);
  }, [generatedAt, view]);

  const handleActiveStopChange = useCallback((stopId: string) => {
    setActiveStopId(stopId);
    setVisitedStopIds((visited) => {
      if (visited.has(stopId)) return visited;
      const next = new Set(visited);
      next.add(stopId);
      return next;
    });
  }, []);

  const handleSelectStop = useCallback(
    (stopId: string) => {
      handleActiveStopChange(stopId);
      setScrollToStopId(stopId);
    },
    [handleActiveStopChange]
  );

  const step = useCallback(
    (delta: number) => {
      if (!view || view.stops.length === 0) return;
      const currentIndex = view.stops.findIndex((stop) => stop.stop.id === activeStopId);
      const nextIndex = Math.min(view.stops.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
      handleSelectStop(view.stops[nextIndex].stop.id);
    },
    [activeStopId, handleSelectStop, view]
  );

  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const sourceValue = source.kind === 'working-tree' ? source.scope : source.kind;
  const sourceLabel = source.kind === 'branch'
    ? t('walkthrough.scope.branch')
    : source.kind === 'pr'
      ? t('walkthrough.scope.pullRequest', { number: source.number })
      : scope === 'all'
        ? t('walkthrough.scope.all')
        : scope === 'staged'
          ? t('walkthrough.scope.staged')
          : t('walkthrough.scope.working');

  // Explicit pick first, then the model that actually produced what is on
  // screen, then whatever settings resolve to. The middle step is what makes
  // reopening a review show the model behind it rather than the default.
  const activeModel = selectedModel
    ?? (entry.result?.model ? `${entry.result.model.providerID}/${entry.result.model.modelID}` : undefined)
    ?? (entry.readiness?.model ? `${entry.readiness.model.providerID}/${entry.readiness.model.modelID}` : undefined);
  const [activeProviderId, ...activeModelParts] = (activeModel ?? '').split('/');
  const activeModelId = activeModelParts.join('/');

  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const [modelProviders, setModelProviders] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    if (modelProviders !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setModelProviders(payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // Leave undefined: the picker then offers every provider, which is
        // worse but not broken.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelProviders]);

  const isStructuredOutputCapable = useCallback(
    (providerId: string, modelId: string) =>
      modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata]
  );

  // Only generation is worth interrupting. A read is a few hundred milliseconds
  // of git with nothing to cancel, and offering a Cancel button for it made the
  // action flicker every time the model or language changed.
  const isGeneratingEntry = entry.status === 'generating';

  // What is on screen versus what is being asked for. A read that has settled
  // is the only thing that can answer this: while one is in flight the panel is
  // still showing the previous answer, and a banner claiming something is
  // missing before we know would be the same flicker in another place.
  const shownModel = entry.result?.model
    ? `${entry.result.model.providerID}/${entry.result.model.modelID}`
    : undefined;
  const shownLanguage = entry.result?.language;
  const shownLocale = shownLanguage && locales.includes(shownLanguage as Locale)
    ? (shownLanguage as Locale)
    : undefined;
  const settled = entry.status === 'ready' && Boolean(view);
  // An entry written before walkthroughs had a language carries none. Unknown
  // is not the same as different, so it is not reported as missing.
  const languageMissing = settled && Boolean(shownLocale) && shownLocale !== activeLanguage;
  const modelMissing = settled && Boolean(shownModel) && Boolean(activeModel) && shownModel !== activeModel;

  // The stage list outlives the work by a beat. Assembling takes milliseconds,
  // so without this the result replaces the list before the last step is ever
  // seen finishing — the user is told about a step they never observe.
  const stageProgress = useWalkthroughStageProgress(entry.stage, entry.status === 'generating');

  // Only a generation that started from an empty panel gets held: regenerating
  // over an existing walkthrough keeps the stream on screen with a banner, and
  // hiding readable content to show a progress list would be a downgrade.
  const startedFromEmptyRef = useRef(false);
  const previousStatusRef = useRef(entry.status);
  useEffect(() => {
    if (previousStatusRef.current !== 'generating' && entry.status === 'generating') {
      startedFromEmptyRef.current = !view;
    }
    previousStatusRef.current = entry.status;
  }, [entry.status, view]);

  const showStages = startedFromEmptyRef.current
    && (entry.status === 'generating' || stageProgress.holding);
  const blockedReason = entry.error?.code === 'context-too-small'
    || entry.error?.code === 'structured-output-unsupported'
    || entry.error?.code === 'no-model'
    || entry.error?.code === 'empty-diff'
    || entry.error?.code === 'only-generated'
    || entry.error?.code === 'output-exhausted'
    ? entry.error.code
    : entry.readiness && !entry.readiness.ready && !view
      ? entry.readiness.reason
      : undefined;

  // Both sources carry the model that was tried; the error is the more specific
  // one when generation actually ran.
  const blockedModel = entry.error?.model ?? entry.readiness?.model;
  const blockedRequiredChars = entry.error?.requiredChars ?? entry.readiness?.requiredChars;
  const blockedAvailableChars = entry.error?.availableChars ?? entry.readiness?.availableChars;

  const handleGenerate = useCallback(
    (force: boolean) => {
      void generate(directory, source, { force, language: activeLanguage });
    },
    [activeLanguage, directory, generate, source]
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <DropdownMenu open={sourceMenuOpen} onOpenChange={setSourceMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md px-2 typography-ui-label font-semibold text-foreground outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('walkthrough.scope.selectorAria')}
            >
              <span className="whitespace-nowrap">{sourceLabel}</span>
              <Icon name="arrow-down-s" className="size-4 flex-shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuRadioGroup
              value={sourceValue}
              onValueChange={(value) => {
                setSourceMenuOpen(false);
                if (value === 'branch') {
                  if (branchSource) requestSource(directory, branchSource);
                  return;
                }
                if (value === 'pr') {
                  if (prSource) requestSource(directory, prSource);
                  return;
                }
                selectWorkingTree(value as WalkthroughWorkingTreeScope);
              }}
            >
              {/* Grouped so "everything" is visibly scoped to uncommitted work:
                  on its own next to "This branch" it read as "all changes that
                  exist", which is the opposite of what it selects. */}
              <DropdownMenuLabel className={SCOPE_GROUP_LABEL_CLASS}>
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
              {(branchSource || prSource) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className={SCOPE_GROUP_LABEL_CLASS}>
                    {t('walkthrough.scope.group.committed')}
                  </DropdownMenuLabel>
                </>
              )}
              {branchSource && (
                <DropdownMenuRadioItem value="branch">
                  {t('walkthrough.scope.branch')}
                </DropdownMenuRadioItem>
              )}
              {prSource && (
                <DropdownMenuRadioItem value="pr">
                  {t('walkthrough.scope.pullRequest', { number: prSource.number })}
                </DropdownMenuRadioItem>
              )}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex min-w-0 items-center gap-1">
          {/* A walkthrough nobody can read is worth nothing, so the prose
              language is a per-review choice like the model — defaulting to the
              interface language, which is the best evidence of what the reader
              reads. */}
          <DropdownMenu open={languageMenuOpen} onOpenChange={setLanguageMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 min-w-0 flex-shrink items-center gap-1.5 rounded-md px-2 typography-ui-label text-muted-foreground outline-none hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('walkthrough.language.selectorAria')}
                title={compactHeader ? label(activeLanguage) : undefined}
              >
                <Icon name="global" className="size-4 flex-shrink-0 opacity-70" />
                {!compactHeader && (
                  <>
                    <span className="truncate">{label(activeLanguage)}</span>
                    <Icon name="arrow-down-s" className="size-4 flex-shrink-0 opacity-60" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className={SCOPE_GROUP_LABEL_CLASS}>
                {t('walkthrough.language.menuLabel')}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={activeLanguage}
                onValueChange={(value) => {
                  setLanguageMenuOpen(false);
                  selectLanguage(directory, source, value);
                }}
              >
                {locales.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {label(value)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Choosing a roomier model for a risky change is a per-review call,
              so this is panel state rather than a settings edit. */}
          <ModelSelector
            providerId={activeProviderId ?? ''}
            modelId={activeModelId}
            onChange={(providerId, modelId) => {
              selectModel(directory, source, providerId && modelId ? `${providerId}/${modelId}` : null);
            }}
            allowedProviderIds={modelProviders}
            isModelAllowed={isStructuredOutputCapable}
            tooltipsEnabled={false}
            dropdownPortalToBody
            compact={compactHeader}
            className={cn('h-8 min-w-0', !compactHeader && 'max-w-48')}
          />
          {view && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('walkthrough.action.previous')}
                onClick={() => step(-1)}
              >
                <Icon name="arrow-right-s" className="size-4 rotate-180" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('walkthrough.action.next')}
                onClick={() => step(1)}
              >
                <Icon name="arrow-right-s" className="size-4" />
              </Button>
            </>
          )}

          {isGeneratingEntry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={compactHeader ? t('walkthrough.action.cancel') : undefined}
              title={compactHeader ? t('walkthrough.action.cancel') : undefined}
              onClick={() => cancel(directory, source)}
            >
              {compactHeader
                ? <Icon name="stop" className="size-3.5" />
                : t('walkthrough.action.cancel')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={WALKTHROUGH_ACTION_CLASS}
              aria-label={compactHeader
                ? (view ? t('walkthrough.action.regenerate') : t('walkthrough.action.generate'))
                : undefined}
              title={compactHeader
                ? (view ? t('walkthrough.action.regenerate') : t('walkthrough.action.generate'))
                : undefined}
              onClick={() => handleGenerate(Boolean(view))}
            >
              <Icon name={view ? 'refresh' : 'route'} className="size-3.5" />
              {!compactHeader && (view ? t('walkthrough.action.regenerate') : t('walkthrough.action.generate'))}
            </Button>
          )}
        </div>
      </header>

      {/* While regenerating over an existing walkthrough the stream keeps showing
          the old content, so the only other signal would be the button swapping
          to Cancel — far too quiet for something that runs for tens of seconds. */}
      {entry.status === 'generating' && view && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-[var(--status-info-background)] px-3 py-2">
          <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-[var(--status-info)]" />
          <span className="typography-meta text-foreground">
            {entry.stage === 'collecting'
              ? t('walkthrough.stage.collecting')
              : entry.stage === 'assembling'
                ? t('walkthrough.stage.assembling')
                : t('walkthrough.stage.asking')}
          </span>
        </div>
      )}

      {/* Switching the model or the language is a request for a walkthrough
          that may not exist yet. Falling back to the last one is better than an
          empty panel, but only if the panel says so — otherwise the picker
          claims Ukrainian over English prose. */}
      {(languageMissing || modelMissing) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-[var(--status-info-background)] px-3 py-2">
          <Icon name="information" className="size-4 shrink-0 text-[var(--status-info)]" />
          <span className="typography-meta text-foreground">
            {languageMissing && modelMissing
              ? t('walkthrough.missing.languageAndModel')
              : languageMissing
                ? t('walkthrough.missing.language', {
                  requested: label(activeLanguage),
                  shown: label(shownLocale as Locale),
                })
                : t('walkthrough.missing.model', { model: activeModelId })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            // Not forced: if an entry for this exact request existed the banner
            // would not be here, and a forced run would refuse the cache it may
            // find on the way.
            onClick={() => handleGenerate(false)}
          >
            {t('walkthrough.action.generate')}
          </Button>
        </div>
      )}

      {view?.isStale && entry.status !== 'generating' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-status-warning/10 px-3 py-2">
          <Icon name="error-warning" className="size-4 shrink-0 text-status-warning" />
          <span className="typography-meta text-foreground">
            {t('walkthrough.stale.banner', { count: view.staleStopCount })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            // Clicking this again mid-flight would abort the running generation
            // and start another — paying for the same answer twice.
            disabled={isGeneratingEntry}
            onClick={() => handleGenerate(true)}
          >
            {t('walkthrough.action.regenerate')}
          </Button>
        </div>
      )}

      {entry.error && !blockedReason && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border/60 bg-status-error/10 px-3 py-2">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-status-error" />
          {/* Provider errors arrive as raw JSON bodies. Show a readable amount
              and keep the rest reachable rather than filling the panel. */}
          <span className="typography-meta line-clamp-2 text-foreground" title={entry.error.message}>
            {entry.error.message}
          </span>
        </div>
      )}

      <div className={cn('flex min-h-0 flex-1', showToc ? 'flex-row' : 'flex-col')}>
        {blockedReason ? (
          <WalkthroughBlocker
            reason={blockedReason}
            model={blockedModel}
            requiredChars={blockedRequiredChars}
            availableChars={blockedAvailableChars}
            onRetry={() => void load(directory, source)}
          />
        ) : showStages ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
            <WalkthroughStages progress={stageProgress} />
          </div>
        ) : view ? (
          <>
            {showToc && (
              <>
                <WalkthroughToc
                  view={view}
                  activeStopId={activeStopId}
                  visitedStopIds={visitedStopIds}
                  onSelectStop={handleSelectStop}
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
                    'before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[\'\']',
                    'hover:bg-interactive-selection focus-visible:bg-interactive-selection focus-visible:outline-none',
                    draggingToc && 'bg-interactive-selection'
                  )}
                />
              </>
            )}
            <WalkthroughStream
              view={view}
              activeStopId={activeStopId}
              scrollToStopId={scrollToStopId}
              onActiveStopChange={handleActiveStopChange}
              onScrollHandled={() => setScrollToStopId(null)}
              renderSideBySide={renderSideBySide}
              wrapLines={wrapLines}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            {entry.status === 'loading' ? (
              <Icon name="loader-4" className="size-6 animate-spin text-muted-foreground" />
            ) : (
              <>
                <Icon name="route" className="size-6 text-muted-foreground" />
                <h3 className="typography-ui-label font-semibold text-foreground">
                  {t('walkthrough.empty.title')}
                </h3>
                <p className="typography-meta max-w-md text-muted-foreground">
                  {t('walkthrough.empty.description')}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
