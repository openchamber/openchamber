import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { z } from 'zod';
import {
  getGitIdentities,
  createGitIdentity,
  updateGitIdentity,
  deleteGitIdentity,
  getGlobalGitIdentity,
} from '@/lib/gitApi';
import type { GitIdentityProfile } from '@/lib/api/types';
import {
  gitIdentityProfileIdSchema,
  gitIdentityProfileSchema,
  gitIdentityProfilesSchema,
  gitIdentitySummarySchema,
} from '@/lib/api/git-identity';
import { loadDesktopSettings, reportSettingsSaveState, updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';

export type { GitIdentityProfile } from '@/lib/api/types';

interface GitIdentitiesStore {
  selectedProfileId: string | null;
  defaultGitIdentityId: string | null;
  profiles: GitIdentityProfile[];
  globalIdentity: GitIdentityProfile | null;
  isLoading: boolean;

  setSelectedProfile: (id: string | null) => void;
  loadProfiles: () => Promise<boolean>;
  loadGlobalIdentity: () => Promise<boolean>;
  loadDefaultGitIdentityId: () => Promise<boolean>;
  setDefaultGitIdentityId: (id: string | null) => Promise<boolean>;
  createProfile: (profile: Omit<GitIdentityProfile, 'id'> & { id?: string }) => Promise<boolean>;
  updateProfile: (id: string, updates: Partial<GitIdentityProfile>) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<boolean>;
  getProfileById: (id: string) => GitIdentityProfile | undefined;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

type RuntimeToken = {
  runtimeKey: string;
  generation: number;
};

let identityRuntimeGeneration = 0;
let activeIdentityRuntimeKey = getRuntimeKey();
let profilesLoadGeneration = 0;
let profilesMutationRevision = 0;
let globalIdentityLoadGeneration = 0;
let defaultIdentityLoadGeneration = 0;
let defaultIdentityMutationGeneration = 0;
const profileMutationGenerations = new Map<string, number>();

const captureRuntime = (): RuntimeToken => ({
  runtimeKey: getRuntimeKey(),
  generation: identityRuntimeGeneration,
});

const isRuntimeCurrent = (token: RuntimeToken): boolean => (
  token.runtimeKey === getRuntimeKey()
  && token.runtimeKey === activeIdentityRuntimeKey
  && token.generation === identityRuntimeGeneration
);

const startProfileMutation = (id: string): RuntimeToken & { mutationGeneration: number } => {
  const mutationGeneration = (profileMutationGenerations.get(id) ?? 0) + 1;
  profileMutationGenerations.set(id, mutationGeneration);
  profilesMutationRevision += 1;
  return { ...captureRuntime(), mutationGeneration };
};

const isProfileMutationCurrent = (
  token: RuntimeToken & { mutationGeneration: number },
  id: string,
): boolean => isRuntimeCurrent(token) && profileMutationGenerations.get(id) === token.mutationGeneration;

const defaultIdentityIdSchema = z.union([gitIdentityProfileIdSchema, z.literal('')])
  .nullable()
  .transform((value) => value || null);

export const useGitIdentitiesStore = create<GitIdentitiesStore>()(
  devtools(
    (set, get) => ({
      selectedProfileId: null,
      defaultGitIdentityId: null,
      profiles: [],
      globalIdentity: null,
      isLoading: false,

      setSelectedProfile: (id) => set({ selectedProfileId: id }),

      loadProfiles: async () => {
        const runtime = captureRuntime();
        const loadGeneration = ++profilesLoadGeneration;
        const mutationRevision = profilesMutationRevision;
        set({ isLoading: true });
        try {
          const profiles = gitIdentityProfilesSchema.parse(await getGitIdentities());
          if (!isRuntimeCurrent(runtime) || loadGeneration !== profilesLoadGeneration) return false;
          if (mutationRevision === profilesMutationRevision) set({ profiles, isLoading: false });
          else set({ isLoading: false });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(runtime) || loadGeneration !== profilesLoadGeneration) return false;
          console.error('Failed to load git identity profiles:', error);
          set({ isLoading: false });
          return false;
        }
      },

      loadGlobalIdentity: async () => {
        const runtime = captureRuntime();
        const loadGeneration = ++globalIdentityLoadGeneration;
        try {
          const raw = await getGlobalGitIdentity();
          const data = raw === null ? null : gitIdentitySummarySchema.parse(raw);
          if (!isRuntimeCurrent(runtime) || loadGeneration !== globalIdentityLoadGeneration) return false;
          // The System identity is offered whether or not this machine has an
          // author configured: it is how a person says no override applies
          // here, and a machine with no author still has to be able to clone.
          set({
            globalIdentity: {
              id: 'global',
              // The display name is the product's word for it, resolved where
              // it is rendered; the author's own name is the safe fallback.
              name: data?.userName ?? '',
              userName: data?.userName ?? '',
              userEmail: data?.userEmail ?? '',
              color: 'info',
              icon: 'fingerprint',
            },
          });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(runtime) || loadGeneration !== globalIdentityLoadGeneration) return false;
          console.error('Failed to load global git identity:', error);
          return false;
        }
      },

      loadDefaultGitIdentityId: async () => {
        const runtime = captureRuntime();
        const loadGeneration = ++defaultIdentityLoadGeneration;
        const mutationGeneration = defaultIdentityMutationGeneration;
        try {
          // Shared settings loading owns the runtime API call, the HTTP
          // fallback, caching and runtime-context invalidation; the generation
          // guards below still reject a read a newer load or write outran.
          const settings = await loadDesktopSettings();
          if (!isRuntimeCurrent(runtime)) return false;
          const defaultId = defaultIdentityIdSchema.parse(settings?.defaultGitIdentityId ?? null);
          if (loadGeneration !== defaultIdentityLoadGeneration
            || mutationGeneration !== defaultIdentityMutationGeneration) return false;
          set({ defaultGitIdentityId: defaultId });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(runtime) || loadGeneration !== defaultIdentityLoadGeneration) return false;
          console.error('Failed to load default git identity setting:', error);
          return false;
        }
      },

      setDefaultGitIdentityId: async (id) => {
        const runtime = captureRuntime();
        const mutationGeneration = ++defaultIdentityMutationGeneration;
        const value = defaultIdentityIdSchema.parse(id);
        try {
          const committed = value;
          await updateDesktopSettings({ defaultGitIdentityId: value ?? '' });
          if (!isRuntimeCurrent(runtime) || mutationGeneration !== defaultIdentityMutationGeneration) return false;
          set({ defaultGitIdentityId: committed });
          return true;
        } catch (error) {
          if (!isRuntimeCurrent(runtime) || mutationGeneration !== defaultIdentityMutationGeneration) return false;
          console.error('Failed to save default git identity setting:', error);
          return false;
        }
      },

      createProfile: async (profileData) => {
        const profile: GitIdentityProfile = {
          ...profileData,
          id: profileData.id || `profile-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          color: profileData.color || 'keyword',
          icon: profileData.icon || 'branch',
        };
        const token = startProfileMutation(profile.id);
        try {
          reportSettingsSaveState('saving');
          const created = gitIdentityProfileSchema.parse(await createGitIdentity(profile));
          if (created.id !== profile.id) throw new Error('Created Git identity profile ID does not match the request');
          if (!isProfileMutationCurrent(token, profile.id)) return false;
          set((state) => ({ profiles: [...state.profiles.filter((entry) => entry.id !== created.id), created] }));
          reportSettingsSaveState('saved');
          return true;
        } catch (error) {
          if (!isProfileMutationCurrent(token, profile.id)) return false;
          reportSettingsSaveState('error');
          console.error('Failed to create git identity profile:', error);
          return false;
        }
      },

      updateProfile: async (id, updates) => {
        const existing = get().profiles.find((profile) => profile.id === id);
        if (!existing) return false;
        const token = startProfileMutation(id);
        try {
          reportSettingsSaveState('saving');
          const updated = gitIdentityProfileSchema.parse(await updateGitIdentity(id, { ...existing, ...updates, id }));
          if (updated.id !== id) throw new Error('Updated Git identity profile ID does not match the request');
          if (!isProfileMutationCurrent(token, id)) return false;
          set((state) => ({ profiles: state.profiles.map((profile) => profile.id === id ? updated : profile) }));
          reportSettingsSaveState('saved');
          return true;
        } catch (error) {
          if (!isProfileMutationCurrent(token, id)) return false;
          reportSettingsSaveState('error');
          console.error('Failed to update git identity profile:', error);
          return false;
        }
      },

      deleteProfile: async (id) => {
        const token = startProfileMutation(id);
        try {
          reportSettingsSaveState('saving');
          await deleteGitIdentity(id);
          if (!isProfileMutationCurrent(token, id)) return false;
          set((state) => ({
            profiles: state.profiles.filter((profile) => profile.id !== id),
            selectedProfileId: state.selectedProfileId === id ? null : state.selectedProfileId,
            defaultGitIdentityId: state.defaultGitIdentityId === id ? null : state.defaultGitIdentityId,
          }));
          reportSettingsSaveState('saved');
          return true;
        } catch (error) {
          if (!isProfileMutationCurrent(token, id)) return false;
          reportSettingsSaveState('error');
          console.error('Failed to delete git identity profile:', error);
          return false;
        }
      },

      getProfileById: (id) => id === 'global'
        ? get().globalIdentity || undefined
        : get().profiles.find((profile) => profile.id === id),

      resetForRuntimeSwitch: (runtimeKey) => {
        identityRuntimeGeneration += 1;
        activeIdentityRuntimeKey = runtimeKey;
        profilesLoadGeneration += 1;
        globalIdentityLoadGeneration += 1;
        defaultIdentityLoadGeneration += 1;
        defaultIdentityMutationGeneration += 1;
        profilesMutationRevision += 1;
        profileMutationGenerations.clear();
        reportSettingsSaveState('saved');
        set({
          selectedProfileId: null,
          defaultGitIdentityId: null,
          profiles: [],
          globalIdentity: null,
          isLoading: false,
        });
      },
    }),
    { name: 'git-identities-store' },
  ),
);
