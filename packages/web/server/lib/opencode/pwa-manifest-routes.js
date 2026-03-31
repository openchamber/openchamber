const DEFAULT_PWA_APP_NAME = 'OpenChamber - AI Coding Assistant';

export const registerPwaManifestRoute = (app, dependencies) => {
  const {
    process,
    resolveProjectDirectory,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readSettingsFromDiskMigrated,
    normalizePwaAppName,
  } = dependencies;

  const recentPwaSessionsCache = new Map();

  const getRecentPwaSessionShortcuts = async (req) => {
    const now = Date.now();

    const resolvedDirectoryResult = await resolveProjectDirectory(req).catch(() => ({ directory: null }));
    const preferredDirectory = typeof resolvedDirectoryResult?.directory === 'string'
      ? resolvedDirectoryResult.directory
      : null;

    const cacheKey = preferredDirectory ? `dir:${preferredDirectory}` : 'global';
    const cached = recentPwaSessionsCache.get(cacheKey);
    if (cached && now - cached.at < 5000) {
      return cached.data;
    }

    const normalizeShortcutTitle = (value, fallback) => {
      const normalized = normalizePwaAppName(value, fallback);
      return normalized.length > 48 ? normalized.slice(0, 48) : normalized;
    };

    const toFiniteNumber = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const normalizeDirectory = (value) => {
      if (typeof value !== 'string') {
        return '';
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return '';
      }
      const normalized = trimmed.replace(/\\/g, '/');
      if (normalized === '/') {
        return '/';
      }
      return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
    };

    const sessionUpdatedAt = (session) => {
      const time = session && typeof session.time === 'object' ? session.time : null;
      return toFiniteNumber(time?.updated) ?? toFiniteNumber(time?.created) ?? 0;
    };

    const filterSessionsByDirectory = (sessions, directory) => {
      const normalizedDirectory = normalizeDirectory(directory);
      if (!normalizedDirectory) {
        return sessions;
      }

      const prefix = normalizedDirectory === '/' ? '/' : `${normalizedDirectory}/`;
      return sessions.filter((session) => {
        const sessionDirectory = normalizeDirectory(session?.directory);
        if (!sessionDirectory) {
          return false;
        }
        return sessionDirectory === normalizedDirectory || (prefix !== '/' && sessionDirectory.startsWith(prefix));
      });
    };

    const listSessions = async (directory) => {
      const query = (() => {
        if (typeof directory !== 'string' || directory.length === 0) {
          return '';
        }
        const preparedDirectory = process.platform === 'win32'
          ? directory.replace(/\//g, '\\\\')
          : directory;
        return `?directory=${encodeURIComponent(preparedDirectory)}`;
      })();

      const response = await fetch(buildOpenCodeUrl(`/session${query}`, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2500),
      });

      if (!response.ok) {
        return [];
      }

      const payload = await response.json().catch(() => null);
      return Array.isArray(payload) ? payload : [];
    };

    try {
      let payload = [];

      if (preferredDirectory) {
        const scopedPayload = await listSessions(preferredDirectory);
        const filteredScopedPayload = filterSessionsByDirectory(scopedPayload, preferredDirectory);

        if (filteredScopedPayload.length > 0) {
          payload = filteredScopedPayload;
        } else {
          const globalPayload = await listSessions(null);
          const filteredGlobalPayload = filterSessionsByDirectory(globalPayload, preferredDirectory);
          payload = filteredGlobalPayload.length > 0 ? filteredGlobalPayload : globalPayload;
        }
      } else {
        payload = await listSessions(null);
      }

      const seen = new Set();
      const rows = [];

      for (const item of payload) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : '';
        if (!id || seen.has(id)) {
          continue;
        }

        seen.add(id);
        const title = normalizeShortcutTitle(item.title, `Session ${rows.length + 1}`);
        const updatedAt = sessionUpdatedAt(item);

        rows.push({ id, title, updatedAt });
      }

      rows.sort((a, b) => b.updatedAt - a.updatedAt);

      const shortcuts = rows.slice(0, 3).map((session) => ({
        name: session.title,
        short_name: session.title.length > 32 ? session.title.slice(0, 32) : session.title,
        description: 'Open recent session',
        url: `/?session=${encodeURIComponent(session.id)}`,
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      }));

      recentPwaSessionsCache.set(cacheKey, { at: now, data: shortcuts });
      return shortcuts;
    } catch {
      recentPwaSessionsCache.set(cacheKey, { at: now, data: [] });
      return [];
    }
  };

  app.get('/manifest.webmanifest', async (req, res) => {
    const hasQueryOverride =
      typeof req.query?.pwa_name === 'string'
      || typeof req.query?.app_name === 'string'
      || typeof req.query?.appName === 'string';

    let queryValueRaw = '';
    if (typeof req.query?.pwa_name === 'string') {
      queryValueRaw = req.query.pwa_name;
    } else if (typeof req.query?.app_name === 'string') {
      queryValueRaw = req.query.app_name;
    } else if (typeof req.query?.appName === 'string') {
      queryValueRaw = req.query.appName;
    }

    const queryOverrideName = normalizePwaAppName(queryValueRaw, '');

    let storedName = '';
    try {
      const settings = await readSettingsFromDiskMigrated();
      storedName = normalizePwaAppName(settings?.pwaAppName, '');
    } catch {
      storedName = '';
    }

    const appName = hasQueryOverride
      ? (queryOverrideName || DEFAULT_PWA_APP_NAME)
      : (storedName || DEFAULT_PWA_APP_NAME);

    const shortName = appName.length > 30 ? appName.slice(0, 30) : appName;
    const recentSessionShortcuts = await getRecentPwaSessionShortcuts(req);

    const manifest = {
      name: appName,
      short_name: shortName,
      description: 'Web interface companion for OpenCode AI coding agent',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#151313',
      theme_color: '#edb449',
      orientation: 'any',
      icons: [
        { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
        { src: '/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
        { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { src: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      ],
      shortcuts: [
        {
          name: 'Appearance Settings',
          short_name: 'Settings',
          description: 'Open appearance settings',
          url: '/?settings=appearance',
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
        ...recentSessionShortcuts,
      ],
      categories: ['developer', 'tools', 'productivity'],
      lang: 'en',
    };

    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.type('application/manifest+json');
    res.send(JSON.stringify(manifest));
  });
};
