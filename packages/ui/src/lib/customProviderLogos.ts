import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useRuntimeObjectUrl, type RuntimeObjectUrl } from '@/lib/runtimeObjectUrl';

const CUSTOM_PROVIDER_LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
const CUSTOM_PROVIDER_LOGO_MAX_BYTES = 1024 * 1024;
const logoMimeSchema = z.enum(CUSTOM_PROVIDER_LOGO_MIMES);

export const customProviderLogoSchema = z.object({
  mime: logoMimeSchema,
  updatedAt: z.number().int().positive(),
});

export type CustomProviderLogo = z.infer<typeof customProviderLogoSchema>;

export const providerLogoUploadSupported = (): boolean => !isVSCodeRuntime();

const logoPath = (providerId: string) => `/api/provider/${encodeURIComponent(providerId)}/logo`;

const MIME_BY_EXTENSION = new Map<string, CustomProviderLogo['mime']>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
]);

const logoMimeOf = (file: File): CustomProviderLogo['mime'] | null => (
  logoMimeSchema.safeParse(file.type.trim().toLowerCase()).data
  ?? MIME_BY_EXTENSION.get(file.name.toLowerCase().split('.').pop() ?? '')
  ?? null
);

export const providerLogoFileProblem = (file: File): 'type' | 'size' | null => {
  if (!logoMimeOf(file)) return 'type';
  if (file.size <= 0 || file.size > CUSTOM_PROVIDER_LOGO_MAX_BYTES) return 'size';
  return null;
};

const readAsDataUrl = (file: File, mime: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = z.string().safeParse(reader.result);
    if (dataUrl.success) resolve(dataUrl.data.replace(/^data:[^;,]*;/i, `data:${mime};`));
    else reject(new Error('Could not read the file'));
  };
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
  reader.readAsDataURL(file);
});

const errorOf = async (response: Response): Promise<Error> => {
  const payload: unknown = await response.json().catch(() => null);
  const message = z.object({ error: z.string() }).safeParse(payload).data?.error;
  return new Error(message ?? `HTTP ${response.status}`);
};

export const uploadProviderLogo = async (providerId: string, file: File): Promise<CustomProviderLogo> => {
  const mime = logoMimeOf(file);
  if (!mime) throw new Error('Logo must be PNG, JPEG, WebP or SVG');
  const response = await runtimeFetch(logoPath(providerId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ dataUrl: await readAsDataUrl(file, mime) }),
  });
  if (!response.ok) throw await errorOf(response);
  const parsed = z.object({ logo: customProviderLogoSchema }).safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Unexpected response');
  return parsed.data.logo;
};

export const removeProviderLogo = async (providerId: string): Promise<void> => {
  const response = await runtimeFetch(logoPath(providerId), { method: 'DELETE', headers: { Accept: 'application/json' } });
  if (!response.ok) throw await errorOf(response);
};

export const useUploadedProviderLogoUrl = (
  providerId: string,
  logo: CustomProviderLogo | undefined,
  themeVariant: 'light' | 'dark',
): RuntimeObjectUrl => {
  const path = logo ? logoPath(providerId) : null;
  const query = logo
    ? new URLSearchParams(logo.mime === 'image/svg+xml' ? { v: String(logo.updatedAt), theme: themeVariant } : { v: String(logo.updatedAt) }).toString()
    : '';
  return useRuntimeObjectUrl(path, query);
};
