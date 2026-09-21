import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';
import {
  cancelWalkthroughGeneration,
  fetchWalkthrough,
  fetchWalkthroughStage,
  generateWalkthrough,
} from '@/lib/walkthrough/api';
import {
  WalkthroughError,
  type WalkthroughModel,
  type WalkthroughReadiness,
  type WalkthroughResult,
  type WalkthroughSource,
  type WalkthroughStage,
  type WalkthroughTarget,
} from '@/lib/walkthrough/types';

export type WalkthroughEntryStatus = 'idle' | 'loading' | 'generating' | 'ready' | 'error';

export interface WalkthroughEntry {
  status: WalkthroughEntryStatus;
  stage: WalkthroughStage | null;
  result: WalkthroughResult | null;
  readiness: WalkthroughReadiness | null;
  error: {
    message: string;
    code?: WalkthroughError['code'];
    model?: WalkthroughModel;
    requiredChars?: number;
    availableChars?: number;
  } | null;
}

const EMPTY_ENTRY: WalkthroughEntry = {
  status: 'idle',
  stage: null,
  result: null,
  readiness: null,
  error: null,
};

export const walkthroughSourceKey = (source: WalkthroughSource): string => {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  if (source.kind === 'commit') return `commit:${source.hash}`;
  return source.sourceRepo ? `pr:${source.sourceRepo.owner}/${source.sourceRepo.repo}:${source.number}` : `pr:${source.number}`;
};

const walkthroughTargetKey = (target: WalkthroughTarget): string => {
  if (!('context' in target)) return walkthroughSourceKey(target.source);
  const { context, source } = target;
  // The named repository keeps equal numbers in different repositories apart,
  // even under one binding: the server refuses the one that is not bound, and
  // that refusal must not be cached under the other's key.
  return JSON.stringify([
    'pr',
    source.number,
    source.sourceRepo ? `${source.sourceRepo.owner}/${source.sourceRepo.repo}` : null,
    ...sourceControlReadContextParts(context),
  ]);
};

const entryKey = (directory: string, target: WalkthroughTarget): string => JSON.stringify([
  getRuntimeKey(),
  directory,
  walkthroughTargetKey(target),
]);

const requestKey = (directory: string): string => JSON.stringify([getRuntimeKey(), directory]);

const toError = (error: unknown): WalkthroughEntry['error'] => {
  if (error instanceof WalkthroughError) {
    return {
      message: error.message,
      code: error.code,
      model: error.model,
      requiredChars: error.requiredChars,
      availableChars: error.availableChars,
    };
  }
  return { message: error instanceof Error ? error.message : 'Something went wrong' };
};

interface WalkthroughState {
  entries: Record<string, WalkthroughEntry>;
  requestedTargets: Record<string, WalkthroughTarget>;
  selectedModel: Record<string, string>;
  selectedLanguage: Record<string, string>;
}

interface WalkthroughActions {
  getEntry: (directory: string, target: WalkthroughTarget) => WalkthroughEntry;
  load: (directory: string, target: WalkthroughTarget, options?: { language?: string }) => Promise<void>;
  generate: (
    directory: string,
    target: WalkthroughTarget,
    options?: { force?: boolean; language?: string }
  ) => Promise<void>;
  cancel: (directory: string, target: WalkthroughTarget) => void;
  requestTarget: (directory: string, target: WalkthroughTarget) => void;
  getRequestedTarget: (directory: string) => WalkthroughTarget | undefined;
  clearRequestedTarget: (directory: string) => void;
  selectModel: (directory: string, target: WalkthroughTarget, model: string | null) => void;
  getSelectedModel: (directory: string, target: WalkthroughTarget) => string | undefined;
  selectLanguage: (directory: string, target: WalkthroughTarget, language: string | null) => void;
  getSelectedLanguage: (directory: string, target: WalkthroughTarget) => string | undefined;
  reset: () => void;
}

const inFlight = new Map<string, AbortController>();
const stagePollers = new Map<string, {
  controller: AbortController;
  timer: ReturnType<typeof setInterval>;
}>();
const STAGE_POLL_MS = 1_000;

export const useWalkthroughStore = create<WalkthroughState & WalkthroughActions>()(
  devtools(
    (set, get) => ({
      entries: {},
      requestedTargets: {},
      selectedModel: {},
      selectedLanguage: {},

      selectLanguage: (directory, target, language) => {
        const key = entryKey(directory, target);
        set((state) => {
          const next = { ...state.selectedLanguage };
          if (language) next[key] = language;
          else delete next[key];
          return { selectedLanguage: next };
        });
      },

      getSelectedLanguage: (directory, target) => get().selectedLanguage[entryKey(directory, target)],

      selectModel: (directory, target, model) => {
        const key = entryKey(directory, target);
        set((state) => {
          const next = { ...state.selectedModel };
          if (model) next[key] = model;
          else delete next[key];
          return { selectedModel: next };
        });
      },

      getSelectedModel: (directory, target) => get().selectedModel[entryKey(directory, target)],

      requestTarget: (directory, target) => {
        const key = requestKey(directory);
        set((state) => ({ requestedTargets: { ...state.requestedTargets, [key]: target } }));
      },

      getRequestedTarget: (directory) => get().requestedTargets[requestKey(directory)],

      clearRequestedTarget: (directory) => {
        const key = requestKey(directory);
        set((state) => {
          if (!state.requestedTargets[key]) return state;
          const next = { ...state.requestedTargets };
          delete next[key];
          return { requestedTargets: next };
        });
      },

      getEntry: (directory, target) => get().entries[entryKey(directory, target)] ?? EMPTY_ENTRY,

      load: async (directory, target, options = {}) => {
        if (!directory) return;
        const key = entryKey(directory, target);
        const current = get().entries[key];
        if (current?.status === 'generating') return;

        inFlight.get(key)?.abort();
        const controller = new AbortController();
        inFlight.set(key, controller);

        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { ...(state.entries[key] ?? EMPTY_ENTRY), status: 'loading', error: null },
          },
        }));

        try {
          const result = await fetchWalkthrough(directory, target, {
            model: get().selectedModel[key],
            language: options.language,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: { status: 'ready', stage: null, result, readiness: result.readiness ?? null, error: null },
            },
          }));

          if (result.generating) {
            void get().generate(directory, target, { language: options.language });
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                ...(state.entries[key] ?? EMPTY_ENTRY),
                status: 'error',
                stage: null,
                error: toError(error),
              },
            },
          }));
        } finally {
          if (inFlight.get(key) === controller) inFlight.delete(key);
        }
      },

      generate: async (directory, target, options = {}) => {
        if (!directory) return;
        const key = entryKey(directory, target);

        inFlight.get(key)?.abort();
        const controller = new AbortController();
        inFlight.set(key, controller);

        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { ...(state.entries[key] ?? EMPTY_ENTRY), status: 'generating', stage: 'collecting', error: null },
          },
        }));

        const stopPolling = () => {
          const poller = stagePollers.get(key);
          if (!poller || poller.controller !== controller) return;
          clearInterval(poller.timer);
          stagePollers.delete(key);
        };

        const previousPoller = stagePollers.get(key);
        if (previousPoller) clearInterval(previousPoller.timer);
        const timer = setInterval(() => {
          void fetchWalkthroughStage(directory, target, controller.signal)
            .then((stage) => {
              if (!stage || controller.signal.aborted) return;
              set((state) => {
                const entry = state.entries[key];
                if (!entry || entry.status !== 'generating' || entry.stage === stage) return state;
                return { entries: { ...state.entries, [key]: { ...entry, stage } } };
              });
            })
            .catch(() => {});
        }, STAGE_POLL_MS);
        stagePollers.set(key, { controller, timer });

        try {
          const result = await generateWalkthrough(directory, target, {
            force: options.force,
            model: get().selectedModel[key],
            language: options.language,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                status: 'ready',
                stage: null,
                result,
                readiness: state.entries[key]?.readiness ?? null,
                error: null,
              },
            },
          }));
        } catch (error) {
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                ...(state.entries[key] ?? EMPTY_ENTRY),
                status: 'error',
                stage: null,
                error: toError(error),
              },
            },
          }));
        } finally {
          stopPolling();
          if (inFlight.get(key) === controller) inFlight.delete(key);
        }
      },

      cancel: (directory, target) => {
        const key = entryKey(directory, target);
        void cancelWalkthroughGeneration(directory, target).catch(() => {});
        inFlight.get(key)?.abort();
        inFlight.delete(key);
        const poller = stagePollers.get(key);
        if (poller) {
          clearInterval(poller.timer);
          stagePollers.delete(key);
        }
        set((state) => {
          const entry = state.entries[key];
          if (!entry) return state;
          return {
            entries: {
              ...state.entries,
              [key]: { ...entry, status: entry.result ? 'ready' : 'idle', stage: null, error: null },
            },
          };
        });
      },

      reset: () => {
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
        for (const poller of stagePollers.values()) clearInterval(poller.timer);
        stagePollers.clear();
        set({ entries: {}, requestedTargets: {}, selectedModel: {}, selectedLanguage: {} });
      },
    }),
    { name: 'walkthrough-store' }
  )
);
