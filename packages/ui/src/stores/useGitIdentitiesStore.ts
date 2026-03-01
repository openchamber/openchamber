import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { getSafeStorage } from "./utils/safeStorage";
import {
  getGitIdentities,
  createGitIdentity,
  updateGitIdentity,
  deleteGitIdentity,
  discoverGitCredentials,
  getGlobalGitIdentity
} from "@/lib/gitApi";
import { updateDesktopSettings } from "@/lib/persistence";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { buildRuntimeApiHeaders, resolveRuntimeApiEndpoint } from "@/lib/instances/runtimeApiBaseUrl";

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface DiscoveredGitCredential {
  host: string;
  username: string;
}

interface GitIdentitiesStore {

  selectedProfileId: string | null;
  defaultGitIdentityId: string | null; // null = unset, 'global' = system, profile id = custom
  profiles: GitIdentityProfile[];
  globalIdentity: GitIdentityProfile | null;
  discoveredCredentials: DiscoveredGitCredential[];
  isLoading: boolean;

  setSelectedProfile: (id: string | null) => void;
  loadProfiles: () => Promise<boolean>;
  loadGlobalIdentity: () => Promise<boolean>;
  loadDiscoveredCredentials: () => Promise<boolean>;
  loadDefaultGitIdentityId: () => Promise<boolean>;
  setDefaultGitIdentityId: (id: string | null) => Promise<boolean>;

  createProfile: (profile: Omit<GitIdentityProfile, 'id'> & { id?: string }) => Promise<boolean>;
  updateProfile: (id: string, updates: Partial<GitIdentityProfile>) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<boolean>;
  getProfileById: (id: string) => GitIdentityProfile | undefined;
  getUnimportedCredentials: () => DiscoveredGitCredential[];
}

declare global {
  interface Window {
    __zustand_git_identities_store__?: UseBoundStore<StoreApi<GitIdentitiesStore>>;
  }
}

export const useGitIdentitiesStore = create<GitIdentitiesStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedProfileId: null,
        defaultGitIdentityId: null,
        profiles: [],
        globalIdentity: null,
        discoveredCredentials: [],
        isLoading: false,

        setSelectedProfile: (id: string | null) => {
          set({ selectedProfileId: id });
        },

        loadProfiles: async () => {
          set({ isLoading: true });
          const previousProfiles = get().profiles;

          try {
            const profiles = await getGitIdentities();
            set({ profiles, isLoading: false });
            return true;
          } catch (error) {
            console.error("Failed to load git identity profiles:", error);
            set({ profiles: previousProfiles, isLoading: false });
            return false;
          }
        },

        loadGlobalIdentity: async () => {
          try {
            const data = await getGlobalGitIdentity();

            if (data && data.userName && data.userEmail) {
              const globalProfile: GitIdentityProfile = {
                id: 'global',
                name: 'Global Identity',
                userName: data.userName,
                userEmail: data.userEmail,
                authType: data.sshCommand ? 'ssh' : undefined,
                sshKey: data.sshCommand ? data.sshCommand.replace('ssh -i ', '') : null,
                color: 'info',
                icon: 'house'
              };
              set({ globalIdentity: globalProfile });
            } else {
              set({ globalIdentity: null });
            }

            return true;
          } catch (error) {
            console.error("Failed to load global git identity:", error);
            set({ globalIdentity: null });
            return false;
          }
        },

        loadDiscoveredCredentials: async () => {
          try {
            const credentials = await discoverGitCredentials();
            set({ discoveredCredentials: credentials });
            return true;
          } catch (error) {
            console.error("Failed to discover git credentials:", error);
            set({ discoveredCredentials: [] });
            return false;
          }
        },

        loadDefaultGitIdentityId: async () => {
          const normalize = (value: unknown): string | null => {
            if (typeof value !== 'string') {
              return null;
            }
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
          };

          try {
            let defaultId: string | null = null;

            if (defaultId === null) {
              const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
              if (runtimeSettings) {
                try {
                  const result = await runtimeSettings.load();
                  const settings = (result?.settings || {}) as Record<string, unknown>;
                  defaultId = normalize(settings.defaultGitIdentityId);
                } catch {
                  // fall through
                }
              }
            }

            if (defaultId === null) {
              try {
                const response = await fetch(resolveRuntimeApiEndpoint('/config/settings'), {
                  method: 'GET',
                  headers: buildRuntimeApiHeaders(),
                });
                if (response.ok) {
                  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
                  defaultId = normalize(data?.defaultGitIdentityId);
                }
              } catch {
                // ignore
              }
            }

            set({ defaultGitIdentityId: defaultId });
            return true;
          } catch (error) {
            console.error('Failed to load default git identity setting:', error);
            return false;
          }
        },

        setDefaultGitIdentityId: async (id) => {
          try {
            const trimmed = typeof id === 'string' ? id.trim() : '';
            const value = trimmed.length > 0 ? trimmed : '';
            await updateDesktopSettings({ defaultGitIdentityId: value });
            set({ defaultGitIdentityId: value.length > 0 ? value : null });
            return true;
          } catch (error) {
            console.error('Failed to save default git identity setting:', error);
            return false;
          }
        },

        createProfile: async (profileData) => {
          try {

            const profile = {
              ...profileData,
              id: profileData.id || `profile-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
              color: profileData.color || 'keyword',
              icon: profileData.icon || 'branch'
            };

            await createGitIdentity(profile);

            await get().loadProfiles();
            return true;
          } catch (error) {
            console.error("Failed to create git identity profile:", error);
            return false;
          }
        },

        updateProfile: async (id, updates) => {
          try {

            const existing = get().profiles.find(p => p.id === id);
            if (!existing) {
              throw new Error("Profile not found");
            }

            const updated = { ...existing, ...updates };
            await updateGitIdentity(id, updated);

            await get().loadProfiles();
            return true;
          } catch (error) {
            console.error("Failed to update git identity profile:", error);
            return false;
          }
        },

        deleteProfile: async (id) => {
          try {
            await deleteGitIdentity(id);

            if (get().selectedProfileId === id) {
              set({ selectedProfileId: null });
            }

            await get().loadProfiles();
            return true;
          } catch (error) {
            console.error("Failed to delete git identity profile:", error);
            return false;
          }
        },

        getProfileById: (id) => {
          const { profiles, globalIdentity } = get();
          if (id === 'global') {
            return globalIdentity || undefined;
          }
          return profiles.find((p) => p.id === id);
        },

        getUnimportedCredentials: () => {
          const { profiles, discoveredCredentials } = get();
          // Filter out credentials that have already been imported as token-based profiles
          return discoveredCredentials.filter(cred => {
            return !profiles.some(p => 
              p.authType === 'token' && p.host === cred.host
            );
          });
        },
      }),
      {
        name: "git-identities-store",
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          selectedProfileId: state.selectedProfileId,
        }),
      },
    ),
    {
      name: "git-identities-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_git_identities_store__ = useGitIdentitiesStore;
}
