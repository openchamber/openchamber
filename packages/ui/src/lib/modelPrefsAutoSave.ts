import { useUIStore } from '@/stores/useUIStore';
import { isApplyingServerSettings, updateDesktopSettings } from '@/lib/persistence';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { CustomProviderIcon } from '@/lib/customProviderIcons';

type ModelRef = { providerID: string; modelID: string };
type ModelPrefsPayload = {
  favoriteModels: ModelRef[];
  hiddenModels: ModelRef[];
  collapsedModelProviders: string[];
  recentModels: ModelRef[];
  recentAgents: string[];
  favoriteAgents: string[];
  recentEfforts: Record<string, string[]>;
  lastUsedEfforts: Record<string, string | null>;
  customProviderIcons: Record<string, CustomProviderIcon>;
};

const refsEqual = (a: ModelRef[], b: ModelRef[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.providerID !== b[i]?.providerID) return false;
    if (a[i]?.modelID !== b[i]?.modelID) return false;
  }
  return true;
};

const stringsEqual = (a: string[], b: string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const recentEffortsEqual = (a: Record<string, string[]>, b: Record<string, string[]>): boolean => {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Array.isArray(b[key]) && stringsEqual(a[key], b[key]));
};

const lastUsedEffortsEqual = (a: Record<string, string | null>, b: Record<string, string | null>): boolean => {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
};

const customProviderIconsEqual = (a: Record<string, CustomProviderIcon>, b: Record<string, CustomProviderIcon>): boolean => {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const snapshotModelPrefs = (): ModelPrefsPayload => {
  const state = useUIStore.getState();
  return {
    favoriteModels: state.favoriteModels,
    hiddenModels: state.hiddenModels,
    collapsedModelProviders: state.collapsedModelProviders,
    recentModels: state.recentModels,
    recentAgents: state.recentAgents,
    favoriteAgents: state.favoriteAgents,
    recentEfforts: state.recentEfforts,
    lastUsedEfforts: state.lastUsedEfforts,
    customProviderIcons: state.customProviderIcons,
  };
};

const modelPrefsEqual = (a: ModelPrefsPayload, b: ModelPrefsPayload): boolean => (
  refsEqual(a.favoriteModels, b.favoriteModels) &&
  refsEqual(a.hiddenModels, b.hiddenModels) &&
  stringsEqual(a.collapsedModelProviders, b.collapsedModelProviders) &&
  refsEqual(a.recentModels, b.recentModels) &&
  stringsEqual(a.recentAgents, b.recentAgents) &&
  stringsEqual(a.favoriteAgents, b.favoriteAgents) &&
  recentEffortsEqual(a.recentEfforts, b.recentEfforts) &&
  lastUsedEffortsEqual(a.lastUsedEfforts, b.lastUsedEfforts) &&
  customProviderIconsEqual(a.customProviderIcons, b.customProviderIcons)
);

const cloneModelPrefs = (prefs: ModelPrefsPayload): ModelPrefsPayload => ({
  favoriteModels: prefs.favoriteModels.slice(),
  hiddenModels: prefs.hiddenModels.slice(),
  collapsedModelProviders: prefs.collapsedModelProviders.slice(),
  recentModels: prefs.recentModels.slice(),
  recentAgents: prefs.recentAgents.slice(),
  favoriteAgents: prefs.favoriteAgents.slice(),
  recentEfforts: Object.fromEntries(Object.entries(prefs.recentEfforts).map(([key, variants]) => [key, variants.slice()])),
  lastUsedEfforts: { ...prefs.lastUsedEfforts },
  customProviderIcons: { ...prefs.customProviderIcons },
});

export const startModelPrefsAutoSave = () => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let lastSent: ModelPrefsPayload | null = null;

  const flush = () => {
    const payload = snapshotModelPrefs();

    if (lastSent && modelPrefsEqual(lastSent, payload)) {
      return;
    }

    lastSent = cloneModelPrefs(payload);

    void updateDesktopSettings(payload).catch(() => {});
  };

  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(() => {
    lastSent = null;
  });

  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    const next = {
      favoriteModels: state.favoriteModels,
      hiddenModels: state.hiddenModels,
      collapsedModelProviders: state.collapsedModelProviders,
      recentModels: state.recentModels,
      recentAgents: state.recentAgents,
      favoriteAgents: state.favoriteAgents,
      recentEfforts: state.recentEfforts,
      lastUsedEfforts: state.lastUsedEfforts,
      customProviderIcons: state.customProviderIcons,
    };
    const prev = {
      favoriteModels: prevState.favoriteModels,
      hiddenModels: prevState.hiddenModels,
      collapsedModelProviders: prevState.collapsedModelProviders,
      recentModels: prevState.recentModels,
      recentAgents: prevState.recentAgents,
      favoriteAgents: prevState.favoriteAgents,
      recentEfforts: prevState.recentEfforts,
      lastUsedEfforts: prevState.lastUsedEfforts,
      customProviderIcons: prevState.customProviderIcons,
    };
    if (modelPrefsEqual(next, prev)) {
      return;
    }
    // Adopted from the server by the settings sync: that is the new baseline,
    // not a change of this window's to send back.
    if (isApplyingServerSettings()) {
      lastSent = cloneModelPrefs(next);
      return;
    }
    // updateDesktopSettings owns the shared debounce and lifecycle flush, so
    // the change is queued immediately and cannot be lost on a quick reload.
    flush();
  });

  return () => {
    unsubscribe();
    unsubscribeRuntime();
  };
};
