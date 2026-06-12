import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProviderIconImage, SettingsPayload } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';

type UploadResult = { ok: boolean; error?: string };

interface ProviderIconStore {
  providerIconImages: Record<string, ProviderIconImage>;
  isLoaded: boolean;
  loadProviderIcons: () => Promise<void>;
  uploadProviderIcon: (providerId: string, file: File) => Promise<UploadResult>;
  selectBuiltInProviderIcon: (providerId: string, builtInProviderId: string) => Promise<UploadResult>;
  removeProviderIcon: (providerId: string) => Promise<UploadResult>;
}

const PROVIDER_ICON_MAX_BYTES = 5 * 1024 * 1024;

let loadProviderIconsInFlight: Promise<void> | null = null;

const sanitizeProviderIconImages = (value: unknown): Record<string, ProviderIconImage> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, ProviderIconImage> = {};
  for (const [rawProviderId, rawIconImage] of Object.entries(value)) {
    const providerId = rawProviderId.trim();
    if (!providerId || !rawIconImage || typeof rawIconImage !== 'object' || Array.isArray(rawIconImage)) {
      continue;
    }

    const candidate = rawIconImage as Record<string, unknown>;
    const mime = typeof candidate.mime === 'string' ? candidate.mime.trim().toLowerCase() : '';
    const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? Math.max(0, Math.round(candidate.updatedAt))
      : 0;

    if (candidate.source === 'custom') {
      if (!mime || updatedAt <= 0) {
        continue;
      }
      result[providerId] = { mime, updatedAt, source: 'custom' };
      continue;
    }

    if (candidate.source !== 'builtin') {
      continue;
    }

    const builtinProviderId = typeof candidate.builtinProviderId === 'string'
      ? candidate.builtinProviderId.trim()
      : '';
    if (!builtinProviderId || updatedAt <= 0) {
      continue;
    }
    result[providerId] = { builtinProviderId, updatedAt, source: 'builtin' };
  }
  return result;
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';
  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const getProviderIconImagesFromSettings = (settings: SettingsPayload | null | undefined): Record<string, ProviderIconImage> => {
  return sanitizeProviderIconImages(settings?.providerIconImages);
};

const normalizeProviderId = (providerId: string): string => providerId.trim();

export const useProviderIconStore = create<ProviderIconStore>()(
  devtools(
    (set, get) => ({
      providerIconImages: {},
      isLoaded: false,

      loadProviderIcons: async () => {
        if (isVSCodeRuntime()) {
          set({ isLoaded: true, providerIconImages: {} });
          return;
        }

        if (loadProviderIconsInFlight) {
          return loadProviderIconsInFlight;
        }

        loadProviderIconsInFlight = (async () => {
          try {
            const response = await runtimeFetch('/api/config/settings', {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });
            if (!response.ok) {
              throw new Error('Failed to load provider icons');
            }
            const settings = (await response.json().catch(() => null)) as SettingsPayload | null;
            set({
              providerIconImages: getProviderIconImagesFromSettings(settings),
              isLoaded: true,
            });
          } catch (error) {
            console.warn('Failed to load provider icons:', error);
            set({ isLoaded: true });
          } finally {
            loadProviderIconsInFlight = null;
          }
        })();

        return loadProviderIconsInFlight;
      },

      uploadProviderIcon: async (providerId, file) => {
        if (isVSCodeRuntime()) {
          return { ok: false, error: 'Custom provider icons are not supported in this runtime' };
        }

        const normalizedProviderId = normalizeProviderId(providerId);
        if (!normalizedProviderId) {
          return { ok: false, error: 'Provider ID is required' };
        }

        const mime = resolveUploadMime(file);
        if (!mime) {
          return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
        }
        if (!Number.isFinite(file.size) || file.size <= 0) {
          return { ok: false, error: 'Icon file is empty' };
        }
        if (file.size > PROVIDER_ICON_MAX_BYTES) {
          return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
        }

        try {
          const dataUrl = await readFileAsDataUrl(file);
          const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);
          const response = await runtimeFetch(`/api/provider/${encodeURIComponent(normalizedProviderId)}/icon`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ dataUrl: normalizedDataUrl }),
          });

          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            return { ok: false, error: payload?.error || 'Failed to upload provider icon' };
          }

          const payload = (await response.json().catch(() => null)) as {
            iconImage?: ProviderIconImage;
            settings?: SettingsPayload;
          } | null;
          const nextImages = payload?.settings
            ? getProviderIconImagesFromSettings(payload.settings)
            : {
                ...get().providerIconImages,
                ...(payload?.iconImage ? { [normalizedProviderId]: payload.iconImage } : {}),
              };
          set({ providerIconImages: nextImages, isLoaded: true });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message || 'Failed to upload provider icon' };
        }
      },

      selectBuiltInProviderIcon: async (providerId, builtInProviderId) => {
        if (isVSCodeRuntime()) {
          return { ok: false, error: 'Custom provider icons are not supported in this runtime' };
        }

        const normalizedProviderId = normalizeProviderId(providerId);
        const normalizedBuiltInProviderId = builtInProviderId.trim();
        if (!normalizedProviderId || !normalizedBuiltInProviderId) {
          return { ok: false, error: 'Provider icon is required' };
        }

        try {
          const response = await runtimeFetch(`/api/provider/${encodeURIComponent(normalizedProviderId)}/icon`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ builtinProviderId: normalizedBuiltInProviderId }),
          });

          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            return { ok: false, error: payload?.error || 'Failed to select provider icon' };
          }

          const payload = (await response.json().catch(() => null)) as {
            iconImage?: ProviderIconImage;
            settings?: SettingsPayload;
          } | null;
          const nextImages = payload?.settings
            ? getProviderIconImagesFromSettings(payload.settings)
            : {
                ...get().providerIconImages,
                ...(payload?.iconImage ? { [normalizedProviderId]: payload.iconImage } : {}),
              };
          set({ providerIconImages: nextImages, isLoaded: true });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message || 'Failed to select provider icon' };
        }
      },

      removeProviderIcon: async (providerId) => {
        if (isVSCodeRuntime()) {
          return { ok: false, error: 'Custom provider icons are not supported in this runtime' };
        }

        const normalizedProviderId = normalizeProviderId(providerId);
        if (!normalizedProviderId) {
          return { ok: false, error: 'Provider ID is required' };
        }

        try {
          const response = await runtimeFetch(`/api/provider/${encodeURIComponent(normalizedProviderId)}/icon`, {
            method: 'DELETE',
            headers: { Accept: 'application/json' },
          });

          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            return { ok: false, error: payload?.error || 'Failed to remove provider icon' };
          }

          const payload = (await response.json().catch(() => null)) as { settings?: SettingsPayload } | null;
          const nextImages = payload?.settings
            ? getProviderIconImagesFromSettings(payload.settings)
            : { ...get().providerIconImages };
          if (!payload?.settings) {
            delete nextImages[normalizedProviderId];
          }
          set({ providerIconImages: nextImages, isLoaded: true });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message || 'Failed to remove provider icon' };
        }
      },
    }),
    { name: 'ProviderIconStore' }
  )
);
