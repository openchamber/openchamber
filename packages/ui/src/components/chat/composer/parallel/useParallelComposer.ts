import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { isAutoModel } from '@/lib/routing/autoModel';
import { useConfigStore } from '@/stores/useConfigStore';
import { useInputStore } from '@/sync/input-store';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { CreateMultiRunParams } from '@/types/multirun';

export type ParallelModel = {
  providerID: string;
  modelID: string;
  variant?: string;
  displayName?: string;
  count: number;
};

export type ParallelVariant = {
  id: string;
  text: string;
  models: ParallelModel[];
};

export type ParallelFuseJudge = { providerID: string; modelID: string; variant?: string; displayName?: string };

export type ParallelComposerState = {
  variants: ParallelVariant[];
  active: number;
  isolate: boolean;
  baseBranch: string;
  /** Null until the project's commands are loaded. */
  setupCommands: string[] | null;
  fuse: ParallelFuseJudge | null;
};

export type ParallelComposerModelInput = Omit<ParallelModel, 'count'>;

const variantId = (index: number): string => String.fromCharCode(65 + index);

const runTitleFrom = (text: string): string => {
  const line = text.split('\n').map((entry) => entry.trim()).find(Boolean) ?? '';
  return line.replace(/^[#>*\-\s]+/, '').slice(0, 80).trim();
};

const countParallelRuns = (state: ParallelComposerState): number => (
  state.variants.reduce((total, variant) => total + variant.models.reduce((sum, model) => sum + model.count, 0), 0)
);

/**
 * "Run in parallel" state of the composer. The editor keeps showing one
 * prompt, the active variant's: switching tabs stores the editor text in the
 * variant it leaves and loads the one it opens, so autocomplete, drafts and
 * attachments stay the composer's own. Only offered on a new-session draft.
 */
export function useParallelComposer(input: {
  enabled: boolean;
  draftOpen: boolean;
  draftProjectId: string | null;
  message: string;
  setMessage: (text: string) => void;
}) {
  const { t } = useI18n();
  const { enabled, draftOpen, draftProjectId, message, setMessage } = input;
  const [state, setState] = React.useState<ParallelComposerState | null>(null);
  const [isLaunching, setIsLaunching] = React.useState(false);
  const messageRef = React.useRef(message);
  messageRef.current = message;

  const enter = React.useCallback((text = '') => {
    const config = useConfigStore.getState();
    const providerID = config.currentProviderId;
    const modelID = config.currentModelId;
    const displayName = config.providers.find((provider) => provider.id === providerID)?.models.find((model) => model.id === modelID)?.name;
    const seed: ParallelModel[] = providerID && modelID && !isAutoModel(providerID, modelID)
      ? [{ providerID, modelID, displayName: displayName || undefined, variant: config.currentVariant || undefined, count: 1 }]
      : [];
    if (text) setMessage(text);
    setState({ variants: [{ id: 'A', text: '', models: seed }], active: 0, isolate: false, baseBranch: '', setupCommands: null, fuse: null });
  }, [setMessage]);

  const exit = React.useCallback(() => setState(null), []);

  // Leaving the draft (or a surface where the mode is not offered) ends it.
  React.useEffect(() => {
    if (!enabled || !draftOpen) setState(null);
  }, [draftOpen, enabled]);

  // Launcher entry points (sidebar, palette, message actions) ask through the UI store.
  const request = useUIStore((store) => store.parallelComposerRequest);
  React.useEffect(() => {
    if (!request || !enabled || !draftOpen) return;
    useUIStore.getState().consumeParallelComposerRequest(request.id);
    enter(request.prompt);
  }, [draftOpen, enabled, enter, request]);

  const update = React.useCallback((recipe: (current: ParallelComposerState) => ParallelComposerState) => {
    setState((current) => (current ? recipe(current) : current));
  }, []);

  const updateActiveModels = React.useCallback((recipe: (models: ParallelModel[]) => ParallelModel[]) => {
    update((current) => ({
      ...current,
      variants: current.variants.map((variant, index) => (index === current.active ? { ...variant, models: recipe(variant.models) } : variant)),
    }));
  }, [update]);

  const addModel = React.useCallback((model: ParallelComposerModelInput) => {
    if (isAutoModel(model.providerID, model.modelID)) return;
    updateActiveModels((models) => {
      // The same model with another thinking effort is a separate lane.
      const existing = models.findIndex((entry) => entry.providerID === model.providerID && entry.modelID === model.modelID && entry.variant === model.variant);
      if (existing >= 0) return models.map((entry, index) => (index === existing ? { ...entry, count: entry.count + 1 } : entry));
      return [...models, { ...model, count: 1 }];
    });
  }, [updateActiveModels]);

  const setModelVariant = React.useCallback((index: number, variant: string | undefined) => {
    updateActiveModels((models) => {
      const target = models[index];
      if (!target) return models;
      const twin = models.findIndex((entry, i) => i !== index && entry.providerID === target.providerID && entry.modelID === target.modelID && entry.variant === variant);
      if (twin < 0) return models.map((entry, i) => (i === index ? { ...entry, variant } : entry));
      // Choosing an effort another chip already has folds the two chips together.
      return models.flatMap((entry, i) => (i === index ? [] : i === twin ? [{ ...entry, count: entry.count + target.count }] : [entry]));
    });
  }, [updateActiveModels]);

  const incrementModel = React.useCallback((index: number) => {
    updateActiveModels((models) => models.map((entry, i) => (i === index ? { ...entry, count: entry.count + 1 } : entry)));
  }, [updateActiveModels]);

  const decrementModel = React.useCallback((index: number) => {
    updateActiveModels((models) => models.flatMap((entry, i) => {
      if (i !== index) return [entry];
      return entry.count > 1 ? [{ ...entry, count: entry.count - 1 }] : [];
    }));
  }, [updateActiveModels]);

  const addVariant = React.useCallback(() => {
    update((current) => {
      const variants = current.variants.map((variant, index) => (index === current.active ? { ...variant, text: messageRef.current } : variant));
      const source = variants[current.active];
      const next: ParallelVariant = { id: variantId(variants.length), text: source.text, models: source.models.map((model) => ({ ...model })) };
      return { ...current, variants: [...variants, next], active: variants.length };
    });
  }, [update]);

  const switchVariant = React.useCallback((target: number) => {
    const current = state;
    if (!current || target === current.active || !current.variants[target]) return;
    const variants = current.variants.map((variant, index) => (index === current.active ? { ...variant, text: messageRef.current } : variant));
    setState({ ...current, variants, active: target });
    setMessage(variants[target].text);
  }, [setMessage, state]);

  const removeVariant = React.useCallback((target: number) => {
    const current = state;
    if (!current || current.variants.length <= 1) return;
    const withText = current.variants.map((variant, index) => (index === current.active ? { ...variant, text: messageRef.current } : variant));
    const variants = withText.filter((_, index) => index !== target).map((variant, index) => ({ ...variant, id: variantId(index) }));
    const active = Math.min(target <= current.active && current.active > 0 ? current.active - 1 : current.active, variants.length - 1);
    setState({ ...current, variants, active });
    setMessage(variants[active].text);
  }, [setMessage, state]);

  const setIsolate = React.useCallback((isolate: boolean) => update((current) => ({ ...current, isolate })), [update]);
  const setBaseBranch = React.useCallback((baseBranch: string) => update((current) => ({ ...current, baseBranch })), [update]);
  const setSetupCommands = React.useCallback((setupCommands: string[]) => update((current) => ({ ...current, setupCommands })), [update]);
  const setFuse = React.useCallback((fuse: ParallelFuseJudge | null) => update((current) => ({ ...current, fuse })), [update]);

  const launch = React.useCallback(async () => {
    const current = state;
    if (!current || isLaunching) return;
    const variants = current.variants.map((variant, index) => (index === current.active ? { ...variant, text: messageRef.current } : variant));
    const ready = variants.filter((variant) => variant.text.trim() && variant.models.length > 0);
    if (ready.length !== variants.length) {
      toast.error(t('chat.parallel.toast.incomplete'));
      return;
    }
    const projects = useProjectsStore.getState();
    const projectId = draftProjectId ?? projects.activeProjectId;
    if (!projectId || !projects.projects.some((project) => project.id === projectId)) {
      toast.error(t('multirun.launcher.project.empty'));
      return;
    }
    if (projectId !== projects.activeProjectId) projects.setActiveProjectIdOnly(projectId);

    const title = runTitleFrom(variants[0].text) || t('chat.parallel.defaultTitle');
    const attachments = useInputStore.getState().attachedFiles;
    const config = useConfigStore.getState();
    const params: CreateMultiRunParams = {
      name: title,
      title,
      groups: variants.map((variant) => ({
        prompt: variant.text.trim(),
        models: variant.models.flatMap((model) => Array.from({ length: model.count }, () => ({
          providerID: model.providerID,
          modelID: model.modelID,
          variant: model.variant,
          displayName: model.displayName,
        }))),
      })),
      agent: config.currentAgentName || undefined,
      isolateRuns: current.isolate,
      worktreeBaseBranch: current.isolate ? current.baseBranch || undefined : undefined,
      files: attachments.length > 0
        ? attachments.map((file) => ({ mime: file.mimeType, filename: file.filename, url: file.dataUrl }))
        : undefined,
      setupCommands: current.isolate ? current.setupCommands?.filter((command) => command.trim()) : undefined,
      autoFusion: current.fuse
        ? { providerID: current.fuse.providerID, modelID: current.fuse.modelID, variant: current.fuse.variant, agent: config.currentAgentName || undefined }
        : undefined,
    };

    setIsLaunching(true);
    try {
      const result = await useMultiRunStore.getState().createMultiRun(params);
      if (!result) {
        toast.error(useMultiRunStore.getState().error ?? t('chat.parallel.toast.failed'));
        return;
      }
      if (result.failedCount > 0) toast.error(t('multirun.launcher.toast.partialFailure', { failed: result.failedCount }));
      setMessage('');
      useInputStore.getState().clearAttachedFiles();
      setState(null);
      useUIStore.getState().setRunOverviewKey(result.groupKey);
    } finally {
      setIsLaunching(false);
    }
  }, [draftProjectId, isLaunching, setMessage, state, t]);

  return {
    state,
    isActive: state !== null,
    isLaunching,
    runCount: state ? countParallelRuns(state) : 0,
    enter,
    exit,
    addModel,
    setModelVariant,
    incrementModel,
    decrementModel,
    addVariant,
    switchVariant,
    removeVariant,
    setIsolate,
    setBaseBranch,
    setSetupCommands,
    setFuse,
    launch,
  };
}

export type ParallelComposer = ReturnType<typeof useParallelComposer>;
