import { z } from 'zod';

import { INERT_IMAGE_CSP, injectSvgRootColor } from './project-icon-routes.js';

const PROVIDER_LOGO_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);

export const PROVIDER_LOGO_MIMES = Object.freeze([...PROVIDER_LOGO_EXTENSIONS.keys()]);
export const PROVIDER_LOGO_MAX_BYTES = 1024 * 1024;
const SVG_THEME_COLORS = new Map([['light', '#111111'], ['dark', '#f5f5f5']]);

export const themedLogoSvg = (data, theme) => {
  const color = SVG_THEME_COLORS.get(theme);
  return color ? injectSvgRootColor(data.toString('utf8'), color) : null;
};

const providerIdSchema = z.string().trim().min(1).max(128);
const readProviderId = (req) => providerIdSchema.safeParse(req.params.providerId).data ?? null;

const parseLogoDataUrl = (value) => {
  const match = z.string().safeParse(value).data?.trim().match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return { ok: false, error: 'dataUrl must be a base64 data URL' };
  }
  const mime = match[1].trim().toLowerCase();
  if (!PROVIDER_LOGO_EXTENSIONS.has(mime)) {
    return { ok: false, error: 'Logo must be PNG, JPEG, WebP or SVG' };
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) {
    return { ok: false, error: 'Logo is empty' };
  }
  if (bytes.length > PROVIDER_LOGO_MAX_BYTES) {
    return { ok: false, error: 'Logo exceeds size limit (1 MB)' };
  }
  return { ok: true, mime, bytes };
};

export const registerProviderLogoRoutes = (app, dependencies) => {
  const { fsPromises, path, crypto, openchamberDataDir, readSettingsFromDiskMigrated, persistResolvedSettings } = dependencies;
  const logosDirPath = path.join(openchamberDataDir, 'provider-logos');

  const filePrefix = (providerId) => `provider-${crypto.createHash('sha1').update(providerId).digest('hex')}-`;
  const logoPath = (providerId, logo) => path.join(
    logosDirPath,
    `${filePrefix(providerId)}${logo.updatedAt}.${PROVIDER_LOGO_EXTENSIONS.get(logo.mime)}`,
  );

  let lastUpdatedAt = 0;
  const nextUpdatedAt = () => {
    lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1);
    return lastUpdatedAt;
  };

  const removeLogoFiles = async (providerId, keepPath) => {
    try {
      const prefix = filePrefix(providerId);
      const names = (await fsPromises.readdir(logosDirPath)).filter((name) => name.startsWith(prefix));
      await Promise.all(names.map(async (name) => {
        const candidate = path.join(logosDirPath, name);
        if (candidate !== keepPath) await fsPromises.unlink(candidate).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('Failed to remove old provider logo files:', error);
    }
  };

  const queues = new Map();
  const serialize = (providerId, task) => {
    const run = (queues.get(providerId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    queues.set(providerId, tail);
    void tail.then(() => {
      if (queues.get(providerId) === tail) queues.delete(providerId);
    });
    return run;
  };

  const writeLogoSetting = async (providerId, logo) => {
    const settings = await persistResolvedSettings((current) => {
      const others = Object.entries(current.customProviderLogos ?? {}).filter(([id]) => id !== providerId);
      return { customProviderLogos: Object.fromEntries(logo ? [...others, [providerId, logo]] : others) };
    });
    const stored = settings?.customProviderLogos?.[providerId];
    if (logo ? stored?.updatedAt !== logo.updatedAt : stored) {
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
      const logo = settings?.customProviderLogos?.[providerId];
      const mime = logo?.mime;
      if (!PROVIDER_LOGO_EXTENSIONS.has(mime) || !Number.isSafeInteger(logo.updatedAt) || logo.updatedAt <= 0) {
        return res.status(404).json({ error: 'Provider logo not found' });
      }

      let data;
      try {
        data = await fsPromises.readFile(logoPath(providerId, logo));
      } catch (error) {
        if (error?.code === 'ENOENT') {
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
    const parsed = parseLogoDataUrl(req.body?.dataUrl);
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
