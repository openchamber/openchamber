/**
 * OpenCode's own per-model settings: `hidden` (out of every OpenCode picker,
 * still usable in pools and by name), `defaultVariant` (the effort a request
 * runs at when it names none) and `lockVariant` (every request runs at it).
 * They live in OpenCode's config, not in OpenChamber's settings, and apply to
 * every OpenCode client. The catalog OpenChamber reads drops them, so the
 * server reads and writes the config files (`/api/config/opencode-model-settings`).
 * A runtime without that route (VS Code) reports `unavailable` and Settings
 * leaves the controls out; pickers then only honor OpenChamber's own hide list.
 */
import React from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

const settingsSchema = z.object({
  hidden: z.boolean().optional(),
  defaultVariant: z.string().optional(),
  lockVariant: z.boolean().optional(),
});
const stateSchema = z.object({
  path: z.string(),
  models: z.record(z.string(), settingsSchema),
  writable: z.boolean(),
});

export type OpenCodeModelSettings = z.infer<typeof settingsSchema>;
/** A change to one model: a value sets the key, `null` removes it. */
export type OpenCodeModelSettingsPatch = {
  hidden?: boolean | null;
  defaultVariant?: string | null;
  lockVariant?: boolean | null;
};

// `failed` keeps what was loaded and waits for an explicit load, so a broken read is not retried on every render.
type Status = 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';

type Store = {
  status: Status;
  path: string | null;
  writable: boolean;
  models: Record<string, OpenCodeModelSettings>;
  /** The last failed read; the settings already loaded stay in place, never replaced by an empty set. */
  error: string | null;
  load: () => Promise<void>;
  save: (providerID: string, modelID: string, settings: OpenCodeModelSettingsPatch) => Promise<void>;
};

const errorText = async (response: Response) => {
  const body: unknown = await response.json().catch(() => null);
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.error : `HTTP ${response.status}`;
};

export const useOpenCodeModelSettings = create<Store>((set, get) => ({
  status: 'idle',
  path: null,
  writable: false,
  models: {},
  error: null,

  load: async () => {
    if (get().status === 'loading') return;
    set({ status: 'loading' });
    try {
      const response = await runtimeFetch('/api/config/opencode-model-settings');
      if (response.status === 404) {
        set({ status: 'unavailable', error: null });
        return;
      }
      if (!response.ok) throw new Error(await errorText(response));
      const state = stateSchema.parse(await response.json());
      set({ status: 'ready', path: state.path, writable: state.writable, models: state.models, error: null });
    } catch (failure) {
      set({ status: 'failed', error: failure instanceof Error ? failure.message : String(failure) });
    }
  },

  save: async (providerID, modelID, settings) => {
    const response = await runtimeFetch('/api/config/opencode-model-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerID, modelID, settings }),
    });
    if (!response.ok) throw new Error(await errorText(response));
    const state = stateSchema.parse(await response.json());
    set({ status: 'ready', path: state.path, writable: state.writable, models: state.models, error: null });
  },
}));

// Settings belong to the server they were read from.
subscribeRuntimeEndpointWillChange(() => {
  useOpenCodeModelSettings.setState({ status: 'idle', path: null, writable: false, models: {}, error: null });
});

/** Loads the settings once per runtime, for a component that needs them. */
export const useLoadedOpenCodeModelSettings = () => {
  const status = useOpenCodeModelSettings((state) => state.status);
  const load = useOpenCodeModelSettings((state) => state.load);
  React.useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);
  return status;
};

/** The effort OpenCode's config locks a model to, when it locks one. */
export const openCodeLockedVariant = (settings: OpenCodeModelSettings | undefined): string | undefined =>
  settings?.lockVariant && settings.defaultVariant ? settings.defaultVariant : undefined;
