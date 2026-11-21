import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { ProjectDirectoryRequest, ProjectDirectoryResolution } from '../projects/project-directory-runtime.js';
import { isString } from '../shared/object-guards.js';

export interface PwaSettings {
  pwaAppName?: JsonValue;
  pwaOrientation?: JsonValue;
}

export interface PwaManifestDependencies {
  process: Pick<NodeJS.Process, 'platform'>;
  resolveProjectDirectory: (request: ProjectDirectoryRequest) => Promise<ProjectDirectoryResolution>;
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  readSettingsFromDiskMigrated: () => Promise<PwaSettings>;
  normalizePwaAppName: (value: JsonValue | undefined, fallback: string) => string;
  normalizePwaOrientation: (value: JsonValue | undefined, fallback: string) => string;
  isRequestAuthorized: (req: Request, res: Response) => Promise<boolean>;
}

interface PwaShortcut {
  name: string;
  short_name: string;
  description: string;
  url: string;
  icons: { src: string; sizes: string; type: string }[];
}

interface SessionFields extends JsonObject {
  id?: JsonValue;
  directory?: JsonValue;
  title?: JsonValue;
  time?: JsonValue;
}

const hasSessionFields = (value: JsonValue | undefined): value is SessionFields =>
  Boolean(value) && typeof value === 'object';

const hasSessionTime = (value: JsonValue | undefined): value is { updated?: JsonValue; created?: JsonValue } =>
  value !== null && typeof value === 'object';

const hasSessionData = (value: JsonValue | undefined): value is { data?: JsonValue } =>
  value !== null && typeof value === 'object';

const isFiniteNumber = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const DEFAULT_PWA_APP_NAME = 'OpenChamber';
const mapPwaOrientationToManifest = (value: string) => {
  if (value === 'portrait') {
    return 'portrait-primary';
  }
  if (value === 'landscape') {
    return 'landscape-primary';
  }
  return undefined;
};

export const registerPwaManifestRoute = (app: Application, dependencies: PwaManifestDependencies) => {
  const {
    process,
    resolveProjectDirectory,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readSettingsFromDiskMigrated,
    normalizePwaAppName,
    normalizePwaOrientation,
    isRequestAuthorized,
  } = dependencies;

  const recentPwaSessionsCache = new Map<string, { at: number; data: PwaShortcut[] }>();

  const getRecentPwaSessionShortcuts = async () => {
    const now = Date.now();

    const resolvedDirectoryResult = await resolveProjectDirectory({}).catch(() => ({ directory: null }));
    const preferredDirectory = resolvedDirectoryResult?.directory ?? null;

    const cacheKey = preferredDirectory ? `dir:${preferredDirectory}` : 'global';
    const cached = recentPwaSessionsCache.get(cacheKey);
    if (cached && now - cached.at < 5000) {
      return cached.data;
    }

    const normalizeShortcutTitle = (value: JsonValue | undefined, fallback: string) => {
      const normalized = normalizePwaAppName(value, fallback);
      return normalized.length > 48 ? normalized.slice(0, 48) : normalized;
    };

    const toFiniteNumber = (value: JsonValue | undefined) => {
      if (isFiniteNumber(value)) {
        return value;
      }
      if (isString(value) && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const normalizeDirectory = (value: JsonValue | undefined) => {
      if (!isString(value)) {
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

    const sessionUpdatedAt = (session: SessionFields) => {
      const time = session && hasSessionTime(session.time) ? session.time : null;
      return toFiniteNumber(time?.updated) ?? toFiniteNumber(time?.created) ?? 0;
    };

    const filterSessionsByDirectory = (sessions: JsonValue[], directory: string) => {
      const normalizedDirectory = normalizeDirectory(directory);
      if (!normalizedDirectory) {
        return sessions;
      }

      const prefix = normalizedDirectory === '/' ? '/' : `${normalizedDirectory}/`;
      return sessions.filter((session) => {
        const sessionDirectory = normalizeDirectory(hasSessionFields(session) ? session.directory : undefined);
        if (!sessionDirectory) {
          return false;
        }
        return sessionDirectory === normalizedDirectory || sessionDirectory.startsWith(prefix);
      });
    };

    const listSessions = async (directory: string | null): Promise<JsonValue[]> => {
      const query = (() => {
        if (directory === null || directory.length === 0) {
          return '';
        }
        const preparedDirectory = process.platform === 'win32'
          ? directory.replace(/\//g, '\\\\')
          : directory;
        return `?directory=${encodeURIComponent(preparedDirectory)}`;
      })();

      const response = await fetch(buildOpenCodeUrl(`/api/session${query}`, ''), {
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

      const body: JsonValue = await response.json().catch(() => null);
      const payload = Array.isArray(body) ? body : hasSessionData(body) ? body.data : undefined;
      return Array.isArray(payload) ? payload : [];
    };

    try {
      let payload: JsonValue[] = [];

      if (preferredDirectory) {
        const scopedPayload = await listSessions(preferredDirectory);
        const filteredScopedPayload = filterSessionsByDirectory(scopedPayload, preferredDirectory);

        if (filteredScopedPayload.length > 0) {
          payload = filteredScopedPayload;
        } else {
          const globalPayload = await listSessions(null);
          const filteredGlobalPayload = filterSessionsByDirectory(globalPayload, preferredDirectory);
          payload = filteredGlobalPayload;
        }
      } else {
        payload = await listSessions(null);
      }

      const seen = new Set();
      const rows: { id: string; title: string; updatedAt: number }[] = [];

      for (const item of payload) {
        if (!hasSessionFields(item)) {
          continue;
        }

        const id = isString(item.id) ? item.id.trim().slice(0, 160) : '';
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
      isString(req.query?.pwa_name)
      || isString(req.query?.app_name)
      || isString(req.query?.appName);

    let queryValueRaw = '';
    if (isString(req.query?.pwa_name)) {
      queryValueRaw = req.query.pwa_name;
    } else if (isString(req.query?.app_name)) {
      queryValueRaw = req.query.app_name;
    } else if (isString(req.query?.appName)) {
      queryValueRaw = req.query.appName;
    }

    const queryOverrideName = normalizePwaAppName(queryValueRaw, '');
    const hasOrientationOverride = isString(req.query?.orientation);
    const queryOverrideOrientation = normalizePwaOrientation(req.query?.orientation, 'system');

    let storedName = '';
    let storedOrientation = 'system';
    try {
      const settings = await readSettingsFromDiskMigrated();
      storedName = normalizePwaAppName(settings?.pwaAppName, '');
      storedOrientation = normalizePwaOrientation(settings?.pwaOrientation, 'system');
    } catch {
      storedName = '';
      storedOrientation = 'system';
    }

    const appName = hasQueryOverride
      ? (queryOverrideName || DEFAULT_PWA_APP_NAME)
      : (storedName || DEFAULT_PWA_APP_NAME);
    const manifestOrientation = mapPwaOrientationToManifest(
      hasOrientationOverride ? queryOverrideOrientation : storedOrientation
    );

    const shortName = appName.length > 30 ? appName.slice(0, 30) : appName;
    const recentSessionShortcuts = await isRequestAuthorized(req, res).catch(() => false)
      ? await getRecentPwaSessionShortcuts()
      : [];

    const manifest = {
      name: appName,
      short_name: shortName,
      description: 'Web interface companion for OpenCode AI coding agent',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay'],
      background_color: '#151313',
      theme_color: '#edb449',
      ...(manifestOrientation && { orientation: manifestOrientation }),
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
