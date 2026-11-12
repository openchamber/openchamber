import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Locale, useI18n } from '@/lib/i18n';
import { buildWalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughTarget } from '@/lib/walkthrough/types';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGitStore } from '@/stores/useGitStore';
import { type WalkthroughEntry, useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useWalkthroughStageProgress } from './useWalkthroughStageProgress';

interface WalkthroughReviewOptions {
  directory: string;
  target: WalkthroughTarget;
  visible: boolean;
  /** A subject the person still has to pick (a branch base, a commit, a pull request): nothing loads. */
  needsSourceSelection: boolean;
  /** Moves when the subject's content moves (a branch's revision, a push to the pull request), so it reads again. */
  revision: string;
}

/**
 * One walkthrough of one target: reading and generating it, the model and the
 * language it is asked in, what blocks it, and where the reader is in it. The
 * desktop panel and the phone's Changes screen show the same walkthrough
 * through this hook and differ only in how they lay it out.
 */
export const useWalkthroughReview = ({ directory, target, visible, needsSourceSelection, revision }: WalkthroughReviewOptions) => {
  const { locale, locales } = useI18n();
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const entry: WalkthroughEntry = useWalkthroughStore((state) => state.getEntry(directory, target));
  const load = useWalkthroughStore((state) => state.load);
  const generate = useWalkthroughStore((state) => state.generate);
  const cancelGeneration = useWalkthroughStore((state) => state.cancel);
  const selectModelInStore = useWalkthroughStore((state) => state.selectModel);
  const selectedModel = useWalkthroughStore((state) => state.getSelectedModel(directory, target));
  const selectLanguageInStore = useWalkthroughStore((state) => state.selectLanguage);
  const selectedLanguage = useWalkthroughStore((state) => state.getSelectedLanguage(directory, target));
  // Without a model of its own the walkthrough stays on the composer's provider.
  const composerProviderId = useConfigStore((state) => state.currentProviderId) || undefined;
  const composerModelId = useConfigStore((state) => state.currentModelId) || undefined;

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
  const lastPrRead = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || needsSourceSelection) return;
    if (target.source.kind === 'pr') {
      const key = JSON.stringify([runtimeKey, directory, target, activeLanguage, selectedModel, composerProviderId, composerModelId, revision]);
      if (lastPrRead.current === key) return;
      lastPrRead.current = key;
    }
    void load(directory, target, { language: activeLanguage, providerID: composerProviderId, modelID: composerModelId });
  }, [activeLanguage, composerProviderId, composerModelId, needsSourceSelection, directory, load, target, selectedModel, revision, visible, runtimeKey]);

  const view = useMemo(() => needsSourceSelection ? null : buildWalkthroughView(entry.result), [needsSourceSelection, entry.result]);

  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [scrollToStopId, setScrollToStopId] = useState<string | null>(null);
  const [visitedStopIds, setVisitedStopIds] = useState<ReadonlySet<string>>(() => new Set());

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

  const clearScrollRequest = useCallback(() => setScrollToStopId(null), []);
  const activeStopPosition = view?.stops.find((stopView) => stopView.stop.id === activeStopId)?.position ?? 1;

  // Explicit pick first, then the model that actually produced what is on
  // screen, then whatever settings resolve to. The middle step is what makes
  // reopening a review show the model behind it rather than the default.
  // Never present a provider without a usable login as the current selection —
  // the picker already hides them from the menu; showing one as selected was
  // the whole "why say so?" failure mode.
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const modelProviders = useCallableModelProviders();

  const providerIsAuthenticated = (providerId: string | undefined) => {
    if (!providerId) return false;
    // Until the auth list loads, do not present a candidate as selected —
    // otherwise an unauthenticated config model flashes in the picker.
    if (modelProviders === undefined) return false;
    return modelProviders.includes(providerId);
  };
  const readinessModelRef = entry.readiness?.model
    && entry.readiness.model.hasLogin !== false
    && providerIsAuthenticated(entry.readiness.model.providerID)
    ? `${entry.readiness.model.providerID}/${entry.readiness.model.modelID}`
    : undefined;
  const resultModelRef = entry.result?.model
    && providerIsAuthenticated(entry.result.model.providerID)
    ? `${entry.result.model.providerID}/${entry.result.model.modelID}`
    : undefined;
  const selectedModelUsable = selectedModel
    && providerIsAuthenticated(selectedModel.split('/')[0])
    ? selectedModel
    : undefined;
  const activeModel = selectedModelUsable ?? resultModelRef ?? readinessModelRef;
  const [activeProviderId, ...activeModelParts] = (activeModel ?? '').split('/');
  const activeModelId = activeModelParts.join('/');

  const isStructuredOutputCapable = useCallback(
    (providerId: string, modelId: string) =>
      modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata]
  );

  // Only generation is worth interrupting. A read is a few hundred milliseconds
  // of git with nothing to cancel, and offering a Cancel button for it made the
  // action flicker every time the model or language changed.
  const isGenerating = entry.status === 'generating';

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
  const stageProgress = useWalkthroughStageProgress(entry.stage, isGenerating);

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
    && (isGenerating || stageProgress.holding);
  // Auth/login gaps are not a full-panel blocker: hide the unusable model and
  // disable Generate instead of explaining a raw provider error.
  const blockedReason = entry.error?.code === 'context-too-small'
    || entry.error?.code === 'structured-output-unsupported'
    || entry.error?.code === 'no-model'
    || entry.error?.code === 'empty-diff'
    || entry.error?.code === 'only-generated'
    || entry.error?.code === 'output-exhausted'
    // Client-detected rather than reported: the server answered something that
    // was not JSON, so it has no walkthrough routes at all.
    || entry.error?.code === 'server-unsupported'
    ? entry.error.code
    : entry.readiness && !entry.readiness.ready && !view
      && entry.readiness.reason !== 'no-provider-login'
      ? entry.readiness.reason
      : undefined;

  // Both sources carry the model that was tried; the error is the more specific
  // one when generation actually ran.
  const blocked = blockedReason
    ? {
      reason: blockedReason,
      model: entry.error?.model ?? entry.readiness?.model,
      requiredChars: entry.error?.requiredChars ?? entry.readiness?.requiredChars,
      availableChars: entry.error?.availableChars ?? entry.readiness?.availableChars,
    }
    : undefined;

  // A failure the panel cannot explain better than the provider did.
  const errorMessage = entry.error && !blockedReason && entry.error.code !== 'no-provider-login'
    ? entry.error.message
    : undefined;

  // Not ready, or no usable selected model, means Generate must not look
  // actionable — including when the resolved model has no login.
  const generateDisabled = needsSourceSelection || !activeModel || Boolean(entry.readiness && !entry.readiness.ready);

  const handleGenerate = useCallback(
    (force: boolean) => {
      if (generateDisabled) return;
      void generate(directory, target, { force, language: activeLanguage, providerID: composerProviderId, modelID: composerModelId });
    },
    [activeLanguage, composerProviderId, composerModelId, directory, generate, generateDisabled, target]
  );

  const cancel = useCallback(() => cancelGeneration(directory, target), [cancelGeneration, directory, target]);
  const retry = useCallback(() => {
    void load(directory, target, { providerID: composerProviderId, modelID: composerModelId });
  }, [composerModelId, composerProviderId, directory, load, target]);
  const selectLanguage = useCallback(
    (language: string) => selectLanguageInStore(directory, target, language),
    [directory, selectLanguageInStore, target]
  );
  const selectModel = useCallback(
    (providerId: string, modelId: string) => {
      selectModelInStore(directory, target, providerId && modelId ? `${providerId}/${modelId}` : null);
    },
    [directory, selectModelInStore, target]
  );

  return {
    entry,
    view,
    isGenerating,
    showStages,
    stageProgress,
    blocked,
    errorMessage,
    languageMissing,
    modelMissing,
    shownLocale,
    activeLanguage,
    selectLanguage,
    activeModelId,
    activeProviderId,
    hasActiveModel: Boolean(activeModel),
    modelProviders,
    isStructuredOutputCapable,
    selectModel,
    generateDisabled,
    handleGenerate,
    cancel,
    retry,
    activeStopId,
    activeStopPosition,
    visitedStopIds,
    scrollToStopId,
    clearScrollRequest,
    handleActiveStopChange,
    handleSelectStop,
    step,
  };
};

export type WalkthroughReview = ReturnType<typeof useWalkthroughReview>;
