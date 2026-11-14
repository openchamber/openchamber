import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useRuntimeObjectUrl, type RuntimeObjectUrl } from '@/lib/runtimeObjectUrl';

/** Mirrors PROVIDER_LOGO_MIMES in packages/web/server/lib/opencode/provider-logo-routes.js. */
const CUSTOM_PROVIDER_LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
const CUSTOM_PROVIDER_LOGO_MAX_BYTES = 1024 * 1024;
const logoMimeSchema = z.enum(CUSTOM_PROVIDER_LOGO_MIMES);

/** What the `customProviderLogos` setting holds per provider ID; the bytes stay on the server. */
export const customProviderLogoSchema = z.object({
  mime: logoMimeSchema,
  updatedAt: z.number().int().positive(),
});

export type CustomProviderLogo = z.infer<typeof customProviderLogoSchema>;

/**
 * Uploaded logos live on the OpenChamber server. VS Code runs none, so it
 * neither offers the upload nor draws one stored by another client.
 */
export const providerLogoUploadSupported = (): boolean => !isVSCodeRuntime();

const logoPath = (providerId: string) => `/api/provider/${encodeURIComponent(providerId)}/logo`;

const MIME_BY_EXTENSION = new Map<string, CustomProviderLogo['mime']>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
]);

// Some systems hand over a file without a type; its extension decides then.
const logoMimeOf = (file: File): CustomProviderLogo['mime'] | null => (
  logoMimeSchema.safeParse(file.type.trim().toLowerCase()).data
  ?? MIME_BY_EXTENSION.get(file.name.toLowerCase().split('.').pop() ?? '')
  ?? null
);

/** Why the server would refuse this file, checked before it is read. */
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

/** Stores `file` as the provider's logo and answers what the setting now holds. Throws on failure. */
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

/** Removes the provider's uploaded logo. Throws on failure. */
export const removeProviderLogo = async (providerId: string): Promise<void> => {
  const response = await runtimeFetch(logoPath(providerId), { method: 'DELETE', headers: { Accept: 'application/json' } });
  if (!response.ok) throw await errorOf(response);
};

/**
 * The uploaded logo as an object URL. An SVG is asked for in the theme's
 * variant, so one drawn in `currentColor` reads on either background; other
 * images keep their own colours.
 */
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
