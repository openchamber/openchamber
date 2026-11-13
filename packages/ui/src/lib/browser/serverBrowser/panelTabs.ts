import { create } from 'zustand';

import type { ServerBrowserScope } from './types';

/**
 * Which Chrome tab on the server each Browser panel tab shows.
 *
 * In server mode a panel tab is a window onto one tab of the chat's Chrome:
 * `+` opens a panel tab and a Chrome tab together, and closing the panel tab
 * closes its Chrome tab. Keyed by scope (one Chrome per chat) and panel tab id,
 * since the same panel tabs follow the user from chat to chat in a directory.
 *
 * In memory only: after a reload each panel tab claims the next unclaimed
 * Chrome tab again, which is the same pairing for the usual one-to-one case.
 */
type PanelTabClaims = {
  readonly claims: Readonly<Record<string, string>>;
  claim: (scopeId: string, panelTabId: string, chromeTabId: string) => void;
  release: (scopeId: string, panelTabId: string) => void;
};

const claimKey = (scopeId: string, panelTabId: string): string => `${scopeId}\u0000${panelTabId}`;

export const useServerBrowserPanelTabs = create<PanelTabClaims>((set) => ({
  claims: {},
  claim: (scopeId, panelTabId, chromeTabId) => set((state) => ({
    claims: { ...state.claims, [claimKey(scopeId, panelTabId)]: chromeTabId },
  })),
  release: (scopeId, panelTabId) => set((state) => {
    const key = claimKey(scopeId, panelTabId);
    if (!(key in state.claims)) return state;
    const next = { ...state.claims };
    delete next[key];
    return { claims: next };
  }),
}));

export const claimedChromeTab = (
  claims: Readonly<Record<string, string>>,
  scopeId: string,
  panelTabId: string,
): string | null => claims[claimKey(scopeId, panelTabId)] ?? null;

/** Chrome tabs of a scope that no panel tab shows yet. */
export const unclaimedChromeTabs = (
  claims: Readonly<Record<string, string>>,
  scope: ServerBrowserScope,
): string[] => {
  const prefix = `${scope.id}\u0000`;
  const taken = new Set(Object.entries(claims)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, tabId]) => tabId));
  return scope.tabs.map((tab) => tab.id).filter((id) => !taken.has(id));
};

/** Panel tab ids of a scope that point at a Chrome tab, keyed by that tab. */
export const panelTabsByChromeTab = (
  claims: Readonly<Record<string, string>>,
  scopeId: string,
): Map<string, string> => {
  const prefix = `${scopeId}\u0000`;
  const result = new Map<string, string>();
  for (const [key, tabId] of Object.entries(claims)) {
    if (key.startsWith(prefix)) result.set(tabId, key.slice(prefix.length));
  }
  return result;
};

/**
 * A profile being signed into from Settings. While set, the Browser panel
 * shows that profile's sign-in browser (instead of the chat's) with a bar to
 * save the sign-in or cancel it.
 */
type ProfileSignIn = { readonly profileId: string; readonly name: string };

type ProfileSignInStore = {
  readonly signIn: ProfileSignIn | null;
  setSignIn: (signIn: ProfileSignIn | null) => void;
};

export const useServerBrowserSignIn = create<ProfileSignInStore>((set) => ({
  signIn: null,
  setSignIn: (signIn) => set({ signIn }),
}));

/**
 * The Browser panel tab that shows the agent's tab of the chat on screen, so
 * the tab strip can mark it, and whether an agent action runs there now.
 * Set by the Server Browser view, which is the only one that knows the pairing.
 */
type AgentPanelTab = { readonly panelTabId: string; readonly acting: boolean };

type AgentPanelTabStore = {
  readonly agentTab: AgentPanelTab | null;
  setAgentTab: (agentTab: AgentPanelTab | null) => void;
};

export const useServerBrowserAgentTab = create<AgentPanelTabStore>((set) => ({
  agentTab: null,
  setAgentTab: (agentTab) => set((state) => (
    state.agentTab?.panelTabId === agentTab?.panelTabId && state.agentTab?.acting === agentTab?.acting ? state : { agentTab }
  )),
}));
