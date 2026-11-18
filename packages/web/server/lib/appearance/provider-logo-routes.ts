import { z } from 'zod';
import type fs from 'node:fs/promises';
import type nodePath from 'node:path';
import type nodeCrypto from 'node:crypto';
import type { Application, QueryValue, Request } from '../shared/http-contracts.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';
import { isString } from '../shared/object-guards.js';

import { INERT_IMAGE_CSP, injectSvgRootColor } from './project-icon-routes.js';

export interface ProviderLogo {
  mime: string;
  updatedAt: number;
}

const logoSettingsUpdateSchema = z.object({ customProviderLogos: z.record(z.string(), z.unknown()) });
export type ProviderLogoSettingsUpdate = z.infer<typeof logoSettingsUpdateSchema>;

export interface ProviderLogoDependencies {
  fsPromises: Pick<typeof fs, 'readdir' | 'unlink' | 'readFile' | 'mkdir' | 'writeFile'>;
  path: Pick<typeof nodePath, 'join'>;
  crypto: Pick<typeof nodeCrypto, 'createHash'>;
  openchamberDataDir: string;
  readSettingsFromDiskMigrated: () => Promise<SettingsDocument>;
  persistResolvedSettings: (resolve: (current: SettingsDocument) => ProviderLogoSettingsUpdate) => Promise<SettingsDocument>;
}

interface LogoUploadBody {
  dataUrl?: unknown;
}

interface ProviderLogoInput {
  mime?: unknown;
  updatedAt?: unknown;
}

type ParsedLogo = { ok: false; error: string } | { ok: true; mime: string; bytes: Buffer };

const hasLogoEntries = (value: unknown): value is Record<string, unknown> => value != null;
const hasLogoFields = (value: unknown): value is ProviderLogoInput => value != null;
const hasUploadBody = (value: unknown): value is LogoUploadBody => value != null;
const hasErrorCode = (value: unknown): value is { code?: unknown } => value != null;
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

const PROVIDER_LOGO_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);

export const PROVIDER_LOGO_MIMES = Object.freeze([...PROVIDER_LOGO_EXTENSIONS.keys()]);
export const PROVIDER_LOGO_MAX_BYTES = 1024 * 1024;
const SVG_THEME_COLORS = new Map<QueryValue | undefined, string>([['light', '#111111'], ['dark', '#f5f5f5']]);
const isProviderLogoMime = (value: unknown): value is string => isString(value) && PROVIDER_LOGO_EXTENSIONS.has(value);

export const themedLogoSvg = (data: Buffer, theme: QueryValue | undefined) => {
  const color = SVG_THEME_COLORS.get(theme);
  return color ? injectSvgRootColor(data.toString('utf8'), color) : null;
};

const providerIdSchema = z.string().trim().min(1).max(128);
const readProviderId = (req: Request) => providerIdSchema.safeParse(req.params.providerId).data ?? null;

const parseLogoDataUrl = (value: LogoUploadBody['dataUrl']): ParsedLogo => {
  const match = z.string().safeParse(value).data?.trim().match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return { ok: false, error: 'dataUrl must be a base64 data URL' };
  }
  const mime = (match[1] ?? '').trim().toLowerCase();
  if (!PROVIDER_LOGO_EXTENSIONS.has(mime)) {
    return { ok: false, error: 'Logo must be PNG, JPEG, WebP or SVG' };
  }
  const bytes = Buffer.from((match[2] ?? '').replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) {
    return { ok: false, error: 'Logo is empty' };
  }
  if (bytes.length > PROVIDER_LOGO_MAX_BYTES) {
    return { ok: false, error: 'Logo exceeds size limit (1 MB)' };
  }
  return { ok: true, mime, bytes };
};

export const registerProviderLogoRoutes = (app: Application, dependencies: ProviderLogoDependencies) => {
  const { fsPromises, path, crypto, openchamberDataDir, readSettingsFromDiskMigrated, persistResolvedSettings } = dependencies;
  const logosDirPath = path.join(openchamberDataDir, 'provider-logos');

  const filePrefix = (providerId: string) => `provider-${crypto.createHash('sha1').update(providerId).digest('hex')}-`;
  const logoPath = (providerId: string, logo: ProviderLogo) => path.join(
    logosDirPath,
    `${filePrefix(providerId)}${logo.updatedAt}.${PROVIDER_LOGO_EXTENSIONS.get(logo.mime)}`,
  );

  let lastUpdatedAt = 0;
  const nextUpdatedAt = () => {
    lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1);
    return lastUpdatedAt;
  };

  const removeLogoFiles = async (providerId: string, keepPath: string | null) => {
    try {
      const prefix = filePrefix(providerId);
      const names = (await fsPromises.readdir(logosDirPath)).filter((name) => name.startsWith(prefix));
      await Promise.all(names.map(async (name) => {
        const candidate = path.join(logosDirPath, name);
        if (candidate !== keepPath) await fsPromises.unlink(candidate).catch((error) => {
          if (!hasErrorCode(error) || error.code !== 'ENOENT') throw error;
        });
      }));
    } catch (error) {
      if (!hasErrorCode(error) || error.code !== 'ENOENT') console.warn('Failed to remove old provider logo files:', error);
    }
  };

  const queues = new Map<string, Promise<ProviderLogo | void>>();
  const serialize = <Result extends ProviderLogo | void>(providerId: string, task: () => Promise<Result>) => {
    const run = (queues.get(providerId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    queues.set(providerId, tail);
    void tail.then(() => {
      if (queues.get(providerId) === tail) queues.delete(providerId);
    });
    return run;
  };

  const writeLogoSetting = async (providerId: string, logo: ProviderLogo | null) => {
    const settings = await persistResolvedSettings((current) => {
      const others = Object.entries(current.customProviderLogos ?? {}).filter(([id]) => id !== providerId);
      return { customProviderLogos: Object.fromEntries(logo ? [...others, [providerId, logo]] : others) };
    });
    const stored = hasLogoEntries(settings?.customProviderLogos) ? settings.customProviderLogos[providerId] : undefined;
    if (logo ? (hasLogoFields(stored) ? stored.updatedAt : undefined) !== logo.updatedAt : stored) {
      throw new Error('The provider logo setting was not saved');
    }
  };

  app.get('/api/provider/:providerId/logo', async (req, res) => {
    const providerId = readProviderId(req);
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const stored = hasLogoEntries(settings?.customProviderLogos) ? settings.customProviderLogos[providerId] : undefined;
      const logo = hasLogoFields(stored) ? stored : undefined;
      const mime = logo?.mime;
      if (!isProviderLogoMime(mime) || !logo || !isSafeInteger(logo.updatedAt) || logo.updatedAt <= 0) {
        return res.status(404).json({ error: 'Provider logo not found' });
      }

      let data;
      try {
        data = await fsPromises.readFile(logoPath(providerId, { mime, updatedAt: logo.updatedAt }));
      } catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Provider logo not found' });
        }
        throw error;
      }

      res.setHeader('Content-Security-Policy', INERT_IMAGE_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (mime !== 'image/svg+xml') {
        res.setHeader('Content-Type', mime);
        return res.send(data);
      }

      const theme = Array.isArray(req.query?.theme) ? req.query.theme[0] : req.query?.theme;
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      return res.send(themedLogoSvg(data, theme) ?? data);
    } catch (error) {
      console.warn('Failed to read provider logo:', error);
      return res.status(500).json({ error: 'Failed to read provider logo' });
    }
  });

  app.put('/api/provider/:providerId/logo', async (req, res) => {
    const providerId = readProviderId(req);
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }
    const parsed = parseLogoDataUrl(hasUploadBody(req.body) ? req.body.dataUrl : undefined);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const logo = await serialize(providerId, async () => {
        const next = { mime: parsed.mime, updatedAt: nextUpdatedAt() };
        const filePath = logoPath(providerId, next);
        await fsPromises.mkdir(logosDirPath, { recursive: true });
        await fsPromises.writeFile(filePath, parsed.bytes);
        try {
          await writeLogoSetting(providerId, next);
        } catch (error) {
          await fsPromises.unlink(filePath).catch(() => {});
          throw error;
        }
        await removeLogoFiles(providerId, filePath);
        return next;
      });
      return res.json({ logo });
    } catch (error) {
      console.warn('Failed to upload provider logo:', error);
      return res.status(500).json({ error: 'Failed to upload provider logo' });
    }
  });

  app.delete('/api/provider/:providerId/logo', async (req, res) => {
    const providerId = readProviderId(req);
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    try {
      await serialize(providerId, async () => {
        await writeLogoSetting(providerId, null);
        await removeLogoFiles(providerId, null);
      });
      return res.json({ logo: null });
    } catch (error) {
      console.warn('Failed to remove provider logo:', error);
      return res.status(500).json({ error: 'Failed to remove provider logo' });
    }
  });
};
