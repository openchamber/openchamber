export const registerProviderIconRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    openchamberDataDir,
    readSettingsFromDiskMigrated,
    persistSettings,
  } = dependencies;

  const providerIconsDirPath = path.join(openchamberDataDir, 'provider-icons');
  const providerIconMimeToExtension = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
  };
  const providerIconExtensionToMime = Object.fromEntries(
    Object.entries(providerIconMimeToExtension).map(([mime, ext]) => [ext, mime])
  );
  const providerIconSupportedMimes = new Set(Object.keys(providerIconMimeToExtension));
  const providerIconMaxBytes = 5 * 1024 * 1024;

  const normalizeProviderIconMime = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'image/jpg') {
      return 'image/jpeg';
    }
    if (providerIconSupportedMimes.has(normalized)) {
      return normalized;
    }
    return null;
  };

  const normalizeProviderId = (value) => {
    return typeof value === 'string' ? value.trim() : '';
  };

  const normalizeBuiltinProviderIconId = (value) => {
    if (typeof value !== 'string') {
      return '';
    }
    const normalized = value.trim();
    return /^[a-z0-9][a-z0-9_.-]*$/i.test(normalized) ? normalized : '';
  };

  const providerIconBaseName = (providerId) => {
    const hash = crypto.createHash('sha1').update(providerId).digest('hex');
    return `provider-${hash}`;
  };

  const providerIconPathForMime = (providerId, mime) => {
    const normalizedMime = normalizeProviderIconMime(mime);
    if (!normalizedMime) {
      return null;
    }
    const ext = providerIconMimeToExtension[normalizedMime];
    return path.join(providerIconsDirPath, `${providerIconBaseName(providerId)}.${ext}`);
  };

  const providerIconPathCandidates = (providerId) => {
    const base = providerIconBaseName(providerId);
    return Object.values(providerIconMimeToExtension).map((ext) => path.join(providerIconsDirPath, `${base}.${ext}`));
  };

  const removeProviderIconFiles = async (providerId, keepPath) => {
    const candidates = providerIconPathCandidates(providerId);
    await Promise.all(candidates.map(async (candidatePath) => {
      if (keepPath && candidatePath === keepPath) {
        return;
      }
      try {
        await fsPromises.unlink(candidatePath);
      } catch (error) {
        if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }));
  };

  const parseProviderIconDataUrl = (value) => {
    if (typeof value !== 'string') {
      return { ok: false, error: 'dataUrl is required' };
    }

    const trimmed = value.trim();
    const match = trimmed.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      return { ok: false, error: 'Invalid dataUrl format' };
    }

    const mime = normalizeProviderIconMime(match[1]);
    if (!mime) {
      return { ok: false, error: 'Icon must be PNG, JPEG, or SVG' };
    }

    try {
      const base64 = match[2].replace(/\s+/g, '');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return { ok: false, error: 'Icon content is empty' };
      }
      if (bytes.length > providerIconMaxBytes) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }
      return { ok: true, mime, bytes };
    } catch {
      return { ok: false, error: 'Failed to decode icon data' };
    }
  };

  const readProviderIconImages = (settings) => {
    return settings?.providerIconImages && typeof settings.providerIconImages === 'object' && !Array.isArray(settings.providerIconImages)
      ? settings.providerIconImages
      : {};
  };

  app.get('/api/provider/:providerId/icon', async (req, res) => {
    const providerId = normalizeProviderId(req.params.providerId);
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const providerIconImages = readProviderIconImages(settings);
      const metadata = providerIconImages[providerId] || null;
      const metadataMime = normalizeProviderIconMime(metadata?.mime);
      const preferredPath = metadataMime ? providerIconPathForMime(providerId, metadataMime) : null;
      const candidates = preferredPath
        ? [preferredPath, ...providerIconPathCandidates(providerId).filter((candidate) => candidate !== preferredPath)]
        : providerIconPathCandidates(providerId);

      for (const iconPath of candidates) {
        try {
          const data = await fsPromises.readFile(iconPath);
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const resolvedMime = iconPath === preferredPath && metadataMime
            ? metadataMime
            : providerIconExtensionToMime[ext] || 'application/octet-stream';
          const contentType = resolvedMime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : resolvedMime;

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.send(data);
        } catch (error) {
          if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
            console.warn('Failed to read provider icon:', error);
            return res.status(500).json({ error: 'Failed to read provider icon' });
          }
        }
      }

      return res.status(404).json({ error: 'Provider icon not found' });
    } catch (error) {
      console.warn('Failed to load provider icon:', error);
      return res.status(500).json({ error: 'Failed to load provider icon' });
    }
  });

  app.put('/api/provider/:providerId/icon', async (req, res) => {
    const providerId = normalizeProviderId(req.params.providerId);
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const builtinProviderId = normalizeBuiltinProviderIconId(req.body?.builtinProviderId);
      if (builtinProviderId) {
        await removeProviderIconFiles(providerId);

        const updatedAt = Date.now();
        const iconImage = { builtinProviderId, updatedAt, source: 'builtin' };
        const updatedSettings = await persistSettings({
          providerIconImages: {
            ...readProviderIconImages(settings),
            [providerId]: iconImage,
          },
        });

        return res.json({ providerId, iconImage, settings: updatedSettings });
      }

      const parsed = parseProviderIconDataUrl(req.body?.dataUrl);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }

      const iconPath = providerIconPathForMime(providerId, parsed.mime);
      if (!iconPath) {
        return res.status(400).json({ error: 'Unsupported icon format' });
      }

      await fsPromises.mkdir(providerIconsDirPath, { recursive: true });
      await fsPromises.writeFile(iconPath, parsed.bytes);
      await removeProviderIconFiles(providerId, iconPath);

      const updatedAt = Date.now();
      const iconImage = { mime: parsed.mime, updatedAt, source: 'custom' };
      const updatedSettings = await persistSettings({
        providerIconImages: {
          ...readProviderIconImages(settings),
          [providerId]: iconImage,
        },
      });

      return res.json({ providerId, iconImage, settings: updatedSettings });
    } catch (error) {
      console.warn('Failed to upload provider icon:', error);
      return res.status(500).json({ error: 'Failed to upload provider icon' });
    }
  });

  app.delete('/api/provider/:providerId/icon', async (req, res) => {
    const providerId = normalizeProviderId(req.params.providerId);
    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      await removeProviderIconFiles(providerId);

      const providerIconImages = { ...readProviderIconImages(settings) };
      delete providerIconImages[providerId];
      const updatedSettings = await persistSettings({ providerIconImages });

      return res.json({ providerId, iconImage: null, settings: updatedSettings });
    } catch (error) {
      console.warn('Failed to remove provider icon:', error);
      return res.status(500).json({ error: 'Failed to remove provider icon' });
    }
  });
};
