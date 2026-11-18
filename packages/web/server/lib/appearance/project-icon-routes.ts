import type fs from 'node:fs/promises';
import type nodePath from 'node:path';
import type nodeCrypto from 'node:crypto';
import type { spawn as nodeSpawn } from 'node:child_process';
import type { Application } from '../shared/http-contracts.js';
import type { SessionProject } from '../projects/contracts.js';
import type { createFsSearchRuntime as createSearchRuntime, FilesystemFile } from '../fs/search.js';
import { isString } from '../shared/object-guards.js';

export interface ProjectIconProject extends SessionProject {
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
}

export interface ProjectIconSettings {
  projects?: unknown;
}

export interface ProjectIconSavedSettings {
  projects?: ProjectIconProject[];
}

export interface ProjectIconDependencies {
  fsPromises: Pick<typeof fs, 'readFile' | 'writeFile' | 'unlink' | 'mkdir' | 'readdir'>;
  path: typeof nodePath;
  crypto: Pick<typeof nodeCrypto, 'createHash'>;
  openchamberDataDir: string;
  sanitizeProjects: (input: ProjectIconSettings['projects']) => ProjectIconProject[] | undefined;
  readSettingsFromDiskMigrated: () => Promise<ProjectIconSettings>;
  persistSettings: (changes: ProjectIconSavedSettings) => Promise<ProjectIconSavedSettings>;
  persistResolvedSettings: (resolve: (current: ProjectIconSettings) => ProjectIconSavedSettings) => Promise<ProjectIconSavedSettings>;
  createFsSearchRuntime: typeof createSearchRuntime;
  spawn: typeof nodeSpawn;
  resolveGitBinaryForSpawn: () => string;
}

interface IconUploadBody {
  dataUrl?: unknown;
  force?: unknown;
}

type ParsedProjectIcon =
  | { ok: false; error: string }
  | { ok: true; mime: string; bytes: Buffer };

interface IconMimeExtensions {
  [mime: string]: string | undefined;
}

interface FaviconExtensionScores {
  [extension: string]: number | undefined;
}

const hasErrorCode = (error: unknown): error is { code?: unknown } =>
  Boolean(error) && typeof error === 'object';

export const INERT_IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const injectSvgRootColor = (svgMarkup: string, color: string) => {
  const svgTagIndex = svgMarkup.search(/<svg\b/i);
  if (svgTagIndex === -1) {
    return svgMarkup;
  }

  const svgOpenTagEndIndex = svgMarkup.indexOf('>', svgTagIndex);
  if (svgOpenTagEndIndex === -1) {
    return svgMarkup;
  }

  const overrideStyle = `<style data-openchamber-theme-icon="1">:root{color:${color}!important;}</style>`;
  return `${svgMarkup.slice(0, svgOpenTagEndIndex + 1)}${overrideStyle}${svgMarkup.slice(svgOpenTagEndIndex + 1)}`;
};

export const registerProjectIconRoutes = (app: Application, dependencies: ProjectIconDependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    openchamberDataDir,
    sanitizeProjects,
    readSettingsFromDiskMigrated,
    persistSettings,
    persistResolvedSettings,
    createFsSearchRuntime,
    spawn,
    resolveGitBinaryForSpawn,
  } = dependencies;

  const projectIconsDirPath = path.join(openchamberDataDir, 'project-icons');
  const projectIconMimeToExtension: IconMimeExtensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
  };
  const projectIconExtensionToMime = Object.fromEntries(
    Object.entries(projectIconMimeToExtension).map(([mime, ext]) => [ext, mime])
  );
  const projectIconSupportedMimes = new Set(Object.keys(projectIconMimeToExtension));
  const projectIconMaxBytes = 5 * 1024 * 1024;
  const projectIconThemeColors = {
    light: '#111111',
    dark: '#f5f5f5',
  };
  const projectIconHexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;

  const normalizeProjectIconMime = (value: string | undefined) => {
    if (value === undefined) {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'image/jpg') {
      return 'image/jpeg';
    }
    if (projectIconSupportedMimes.has(normalized)) {
      return normalized;
    }
    return null;
  };

  const projectIconBaseName = (projectId: string) => {
    const hash = crypto.createHash('sha1').update(projectId).digest('hex');
    return `project-${hash}`;
  };

  const projectIconPathForMime = (projectId: string, mime: string) => {
    const normalizedMime = normalizeProjectIconMime(mime);
    if (!normalizedMime) {
      return null;
    }
    const ext = projectIconMimeToExtension[normalizedMime];
    return path.join(projectIconsDirPath, `${projectIconBaseName(projectId)}.${ext}`);
  };

  const projectIconPathCandidates = (projectId: string) => {
    const base = projectIconBaseName(projectId);
    return Object.values(projectIconMimeToExtension).map((ext) => path.join(projectIconsDirPath, `${base}.${ext}`));
  };

  const removeProjectIconFiles = async (projectId: string, keepPath?: string) => {
    const candidates = projectIconPathCandidates(projectId);
    await Promise.all(candidates.map(async (candidatePath) => {
      if (keepPath && candidatePath === keepPath) {
        return;
      }
      try {
        await fsPromises.unlink(candidatePath);
      } catch (error) {
        if (!hasErrorCode(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }));
  };

  const parseProjectIconDataUrl = (value: string | undefined): ParsedProjectIcon => {
    if (value === undefined) {
      return { ok: false, error: 'dataUrl is required' };
    }

    const trimmed = value.trim();
    const match = trimmed.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      return { ok: false, error: 'Invalid dataUrl format' };
    }

    const mime = normalizeProjectIconMime(match[1]);
    if (!mime || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(mime)) {
      return { ok: false, error: 'Icon must be PNG, JPEG, or SVG' };
    }

    try {
      const base64 = (match[2] ?? '').replace(/\s+/g, '');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        return { ok: false, error: 'Icon content is empty' };
      }
      if (bytes.length > projectIconMaxBytes) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }
      return { ok: true, mime, bytes };
    } catch {
      return { ok: false, error: 'Failed to decode icon data' };
    }
  };

  const normalizeProjectIconThemeVariant = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'light' || normalized === 'dark') {
      return normalized;
    }
    return null;
  };

  const normalizeProjectIconColor = (value: string) => {
    const normalized = value.trim();
    if (!projectIconHexColorPattern.test(normalized)) {
      return null;
    }
    return normalized;
  };

  const applyProjectIconSvgTheme = (svgMarkup: string, themeVariant: 'light' | 'dark' | null, iconColor: string | null) => {
    const color = iconColor || (themeVariant === null ? undefined : projectIconThemeColors[themeVariant]);
    if (!color) {
      return svgMarkup;
    }

    return injectSvgRootColor(svgMarkup, color);
  };

  const findProjectById = (settings: ProjectIconSettings, projectId: string) => {
    const projects = sanitizeProjects(settings?.projects) || [];
    const index = projects.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return { projects, index: -1, project: null };
    }
    return { projects, index, project: projects[index] };
  };

  const scoreFaviconCandidate = (entry: FilesystemFile) => {
    const relPath = (entry.relativePath || '').replace(/\\/g, '/');
    const lowerPath = relPath.toLowerCase();
    const ext = (entry.extension || path.extname(entry.path || '').slice(1)).toLowerCase();

    if (/(^|\/)\.[^/]/i.test(relPath) || /(^|\/)(tests?|fixtures?|mocks?|examples?|docs?|vendor|third_party)(\/|$)/i.test(lowerPath)) {
      return -1000;
    }

    let score = 0;

    const extScores: FaviconExtensionScores = {
      svg: 50,
      png: 40,
      webp: 30,
      ico: 20,
      jpg: 10,
      jpeg: 10,
    };
    score += extScores[ext] || 0;

    const segments = relPath.split('/').filter(Boolean);
    const depth = segments.length;

    if (depth === 1) {
      score += 40;
    } else if (/(^|\/)(public|static|assets|src\/assets)(\/|$)/i.test(lowerPath)) {
      score += 30;
    }

    score -= Math.min(depth * 5, 25);

    score -= Math.min(relPath.length * 0.1, 10);

    return score;
  };

  const fsSearchRuntime = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn,
  });

  app.get('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = isString(req.params.projectId) ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const metadataMime = normalizeProjectIconMime(project.iconImage?.mime);
      const preferredPath = metadataMime ? projectIconPathForMime(projectId, metadataMime) : null;
      const candidates = preferredPath
        ? [preferredPath, ...projectIconPathCandidates(projectId).filter((candidate) => candidate !== preferredPath)]
        : projectIconPathCandidates(projectId);

      const themeQuery = Array.isArray(req.query?.theme) ? req.query.theme[0] : req.query?.theme;
      const requestedThemeVariant = isString(themeQuery) ? normalizeProjectIconThemeVariant(themeQuery) : null;
      const iconColorQuery = Array.isArray(req.query?.iconColor) ? req.query.iconColor[0] : req.query?.iconColor;
      const requestedIconColor = isString(iconColorQuery) ? normalizeProjectIconColor(iconColorQuery) : null;

      for (const iconPath of candidates) {
        try {
          const data = await fsPromises.readFile(iconPath);
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const resolvedMime = iconPath === preferredPath && metadataMime
            ? metadataMime
            : projectIconExtensionToMime[ext] || 'application/octet-stream';
          const contentType = resolvedMime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : resolvedMime;
          res.setHeader('Content-Security-Policy', INERT_IMAGE_CSP);
          res.setHeader('X-Content-Type-Options', 'nosniff');

          if (resolvedMime === 'image/svg+xml' && requestedThemeVariant) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          if (resolvedMime === 'image/svg+xml' && requestedIconColor) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.send(data);
        } catch (error) {
          if (!hasErrorCode(error) || error.code !== 'ENOENT') {
            console.warn('Failed to read project icon:', error);
            return res.status(500).json({ error: 'Failed to read project icon' });
          }
        }
      }

      return res.status(404).json({ error: 'Project icon not found' });
    } catch (error) {
      console.warn('Failed to load project icon:', error);
      return res.status(500).json({ error: 'Failed to load project icon' });
    }
  });

  app.put<IconUploadBody>('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = isString(req.params.projectId) ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const parsed = parseProjectIconDataUrl(isString(req.body?.dataUrl) ? req.body.dataUrl : undefined);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { projects, project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const iconPath = projectIconPathForMime(projectId, parsed.mime);
      if (!iconPath) {
        return res.status(400).json({ error: 'Unsupported icon format' });
      }

      await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
      await fsPromises.writeFile(iconPath, parsed.bytes);
      await removeProjectIconFiles(projectId, iconPath);

      const updatedAt = Date.now();
      const nextProjects = projects.map<ProjectIconProject>((entry) => (
        entry.id === projectId
          ? { ...entry, iconImage: { mime: parsed.mime, updatedAt, source: 'custom' } }
          : entry
      ));
      const updatedSettings = await persistSettings({ projects: nextProjects });
      const updatedProject = (updatedSettings.projects || []).find((entry) => entry.id === projectId) || null;

      return res.json({ project: updatedProject, settings: updatedSettings });
    } catch (error) {
      console.warn('Failed to upload project icon:', error);
      return res.status(500).json({ error: 'Failed to upload project icon' });
    }
  });

  app.delete('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = isString(req.params.projectId) ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { projects, project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      await removeProjectIconFiles(projectId);

      const nextProjects = projects.map((entry) => (
        entry.id === projectId
          ? { ...entry, iconImage: null }
          : entry
      ));
      const updatedSettings = await persistSettings({ projects: nextProjects });
      const updatedProject = (updatedSettings.projects || []).find((entry) => entry.id === projectId) || null;

      return res.json({ project: updatedProject, settings: updatedSettings });
    } catch (error) {
      console.warn('Failed to remove project icon:', error);
      return res.status(500).json({ error: 'Failed to remove project icon' });
    }
  });

  app.post<IconUploadBody>('/api/projects/:projectId/icon/discover', async (req, res) => {
    const projectId = isString(req.params.projectId) ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const force = req.body?.force === true;
      if (project.iconImage?.source === 'custom' && !force) {
        return res.json({
          project,
          skipped: true,
          reason: 'custom-icon-present',
        });
      }

      const faviconCandidates = await fsSearchRuntime.searchFilesystemFiles(project.path, {
        limit: 200,
        query: 'favicon',
        includeHidden: false,
        respectGitignore: true,
      });

      const filtered = faviconCandidates
        .filter((entry) => {
          const relPath = (entry.relativePath || '').replace(/\\/g, '/');
          return /(^|\/)favicon\.(ico|png|svg|jpg|jpeg|webp)$/i.test(relPath) && scoreFaviconCandidate(entry) > -500;
        })
        .sort((a, b) => scoreFaviconCandidate(b) - scoreFaviconCandidate(a));

      const selected = filtered[0];
      if (!selected) {
        return res.status(404).json({ error: 'No favicon found in project' });
      }

      const ext = path.extname(selected.path).slice(1).toLowerCase();
      const mime = projectIconExtensionToMime[ext] || null;
      if (!mime) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      const bytes = await fsPromises.readFile(selected.path);
      if (bytes.length === 0) {
        return res.status(400).json({ error: 'Discovered icon is empty' });
      }
      if (bytes.length > projectIconMaxBytes) {
        return res.status(400).json({ error: 'Discovered icon exceeds size limit (5 MB)' });
      }

      const iconPath = projectIconPathForMime(projectId, mime);
      if (!iconPath) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      const { project: latest } = findProjectById(await readSettingsFromDiskMigrated(), projectId);
      if (!latest) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (latest.iconImage?.source === 'custom' && !force) {
        return res.json({
          project: latest,
          skipped: true,
          reason: 'custom-icon-present',
        });
      }

      await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
      await fsPromises.writeFile(iconPath, bytes);
      await removeProjectIconFiles(projectId, iconPath);

      const updatedAt = Date.now();
      const updatedSettings = await persistResolvedSettings((current) => {
        const { projects, project: currentProject } = findProjectById(current, projectId);
        if (!currentProject) return {};
        return {
          projects: projects.map((entry) => (
            entry.id === projectId
              ? { ...entry, iconImage: { mime, updatedAt, source: 'auto' } }
              : entry
          )),
        };
      });
      const updatedProject = (updatedSettings.projects || []).find((entry) => entry.id === projectId) || null;

      return res.json({
        project: updatedProject,
        settings: updatedSettings,
        discoveredPath: selected.path,
      });
    } catch (error) {
      console.warn('Failed to discover project icon:', error);
      return res.status(500).json({ error: 'Failed to discover project icon' });
    }
  });
};
