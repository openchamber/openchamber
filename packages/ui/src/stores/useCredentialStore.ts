import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  type QuotaCredentialCreate,
  type QuotaCredentialRecord,
  type QuotaCredentialUpdate,
  type QuotaCredentialValidationResult,
  type QuotaProviderId,
} from '@/types/quota';
import { runtimeFetch } from '@/lib/runtime-fetch';

export interface CredentialState {
  records: QuotaCredentialRecord[];
  isLoading: boolean;
  error: string | null;

  fetchCredentials: () => Promise<void>;
  addCredential: (input: QuotaCredentialCreate) => Promise<QuotaCredentialRecord>;
  updateCredential: (id: string, input: QuotaCredentialUpdate) => Promise<QuotaCredentialRecord>;
  deleteCredential: (id: string) => Promise<void>;
  validateCredential: (id: string) => Promise<QuotaCredentialValidationResult>;
  discoverLegacyCredentials: (
    providerId: QuotaProviderId,
  ) => Promise<{ filePath: string; timestamp: number } | null>;
}

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

// Extract a server-provided error message from an already-parsed JSON body.
// The Response body is read exactly once by the caller; this must not call
// `response.json()` again.
const errorFromPayload = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string') {
    return (payload as { error: string }).error;
  }
  return fallback;
};

const encodeId = (id: string): string => encodeURIComponent(id);
const encodeProviderId = (providerId: QuotaProviderId): string => encodeURIComponent(providerId);

export const useCredentialStore = create<CredentialState>()(
  devtools(
    (set) => ({
      records: [],
      isLoading: false,
      error: null,

      fetchCredentials: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await runtimeFetch('/api/quota/credentials');
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(errorFromPayload(payload, 'Failed to fetch credentials'));
          }
          const records = Array.isArray(payload) ? (payload as QuotaCredentialRecord[]) : [];
          set({ records, isLoading: false, error: null });
        } catch (error) {
          set({ isLoading: false, error: errorMessage(error, 'Failed to fetch credentials') });
        }
      },

      addCredential: async (input) => {
        try {
          const response = await runtimeFetch('/api/quota/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(errorFromPayload(payload, 'Failed to add credential'));
          }
          const record = payload as QuotaCredentialRecord;
          // Only the server-sanitized record is stored; the raw input.credential secret never persists in store state.
          set((state) => ({
            records: [...state.records.filter((r) => r.id !== record.id), record],
            error: null,
          }));
          return record;
        } catch (error) {
          set({ error: errorMessage(error, 'Failed to add credential') });
          throw error;
        }
      },

      updateCredential: async (id, input) => {
        try {
          const response = await runtimeFetch(`/api/quota/credentials/${encodeId(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(errorFromPayload(payload, 'Failed to update credential'));
          }
          const record = payload as QuotaCredentialRecord;
          set((state) => ({
            records: state.records.map((r) => (r.id === id ? record : r)),
            error: null,
          }));
          return record;
        } catch (error) {
          set({ error: errorMessage(error, 'Failed to update credential') });
          throw error;
        }
      },

      deleteCredential: async (id) => {
        try {
          const response = await runtimeFetch(`/api/quota/credentials/${encodeId(id)}`, {
            method: 'DELETE',
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(errorFromPayload(payload, 'Failed to delete credential'));
          }
          set((state) => ({
            records: state.records.filter((r) => r.id !== id),
            error: null,
          }));
        } catch (error) {
          set({ error: errorMessage(error, 'Failed to delete credential') });
          throw error;
        }
      },

      validateCredential: async (id) => {
        try {
          const response = await runtimeFetch(`/api/quota/credentials/${encodeId(id)}/validate`, {
            method: 'POST',
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(errorFromPayload(payload, 'Failed to validate credential'));
          }
          const result = payload as QuotaCredentialValidationResult;
          // valid:false is a legitimate validation outcome, not an error state.
          set((state) => ({
            records: state.records.map((r) =>
              r.id === id
                ? {
                    ...r,
                    validationStatus: result.valid ? 'valid' : 'invalid',
                    lastValidatedAt: Date.now(),
                  }
                : r,
            ),
            error: null,
          }));
          return result;
        } catch (error) {
          set({ error: errorMessage(error, 'Failed to validate credential') });
          throw error;
        }
      },

      discoverLegacyCredentials: async (providerId) => {
        // Display-only discovery probe. A null result covers both "no legacy
        // credentials" and transient fetch failure; callers treat it as a hint.
        try {
          const response = await runtimeFetch(
            `/api/quota/credentials/legacy/${encodeProviderId(providerId)}`,
          );
          if (!response.ok) return null;
          const payload = await response.json().catch(() => null);
          if (
            !payload ||
            typeof payload.filePath !== 'string' ||
            typeof payload.timestamp !== 'number'
          ) {
            return null;
          }
          return { filePath: payload.filePath, timestamp: payload.timestamp };
        } catch {
          return null;
        }
      },
    }),
    { name: 'credential-store' },
  ),
);

// Pure selectors take state explicitly (testable, usable via .getState()).
// useShallow keeps the provider-scoped array referentially stable so unrelated
// state changes (e.g. isLoading) don't re-render provider subscribers.

export const selectCredentialsByProvider = (
  state: CredentialState,
  providerId: QuotaProviderId,
): QuotaCredentialRecord[] => state.records.filter((r) => r.providerId === providerId);

export const selectCredentialById = (
  state: CredentialState,
  id: string,
): QuotaCredentialRecord | undefined => state.records.find((r) => r.id === id);

export function useCredentialsByProvider(providerId: QuotaProviderId): QuotaCredentialRecord[] {
  return useCredentialStore(
    useShallow((state) => selectCredentialsByProvider(state, providerId)),
  );
}

export function useCredentialById(id: string): QuotaCredentialRecord | undefined {
  return useCredentialStore((state) => selectCredentialById(state, id));
}
