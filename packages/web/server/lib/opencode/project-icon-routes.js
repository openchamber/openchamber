import { constants as nodeFsConstants } from 'node:fs';

// Flags for opening a stored icon for serving: O_NONBLOCK (POSIX only)
// keeps open() itself from blocking on a FIFO with no writer before the
// handle stat can judge it non-regular (#1537) - the same pattern as
// shared/bounded-file-read.js's openFlags.
const storedIconOpenFlags = (platform) =>
  platform === 'win32' || nodeFsConstants.O_NONBLOCK === undefined
    ? 'r'
    : nodeFsConstants.O_RDONLY | nodeFsConstants.O_NONBLOCK;

// Discovery reads project-controlled files, so its open must not follow
// a final-component symlink either (#2294): O_NOFOLLOW binds the read to
// the file the pathname validation judged — a symlink swapped in after
// validation fails the open with ELOOP instead of being followed. (A
// directory-component swap mid-request has no portable Node primitive;
// the lstat + realpath containment check above remains the guard there.)
const discoveredIconOpenFlags = (platform) =>
  platform === 'win32' || nodeFsConstants.O_NOFOLLOW === undefined
    ? storedIconOpenFlags(platform)
    : storedIconOpenFlags(platform) | nodeFsConstants.O_NOFOLLOW;

export const registerProjectIconRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    openchamberDataDir,
    sanitizeProjects,
    readSettingsFromDiskMigrated,
    persistSettings,
    createFsSearchRuntime,
    spawn,
    resolveGitBinaryForSpawn,
  } = dependencies;

  const projectIconsDirPath = path.join(openchamberDataDir, 'project-icons');
  const projectIconMimeToExtension = {
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
  const projectIconReadChunkBytes = 64 * 1024;
  const projectIconThemeColors = {
    light: '#111111',
    dark: '#f5f5f5',
  };
  const projectIconHexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;

  // Open with the stored-icon flags (#1788): a project-controlled
  // favicon can be a FIFO, and a plain 'r' open blocks on it forever
  // before the handle stat can judge it non-regular - the same
  // open-before-guard shape #1537 fixed for the stored-icon reader.
  // A discovered favicon is project-controlled input (#2294): a symlink
  // named like a favicon would make readDiscoveredIcon read its target,
  // which can live anywhere the server process can reach. A candidate is
  // discoverable only when it is not a symlink itself and its resolved
  // path stays inside the resolved project directory.
  const resolveDiscoverableIconPath = async (candidatePath, projectPath) => {
    try {
      const linkStats = await fsPromises.lstat(candidatePath);
      if (linkStats.isSymbolicLink()) {
        return null;
      }
      const [realProjectPath, realCandidatePath] = await Promise.all([
        fsPromises.realpath(projectPath),
        fsPromises.realpath(candidatePath),
      ]);
      const normalize = (value) => value.replace(/\\/g, '/');
      const root = normalize(realProjectPath);
      const resolved = normalize(realCandidatePath);
      if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        return null;
      }
      return candidatePath;
    } catch {
      return null;
    }
  };

  const readDiscoveredIcon = async (filePath) => {
    let handle;
    try {
      handle = await fsPromises.open(filePath, discoveredIconOpenFlags(process.platform));
    } catch (error) {
      if (error?.code === 'ELOOP') {
        return { ok: false, reason: 'symlink' };
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (stats.isFile?.() === false) {
        return { ok: false, reason: 'not-regular' };
      }
      if (stats.size === 0) {
        return { ok: false, reason: 'empty' };
      }
      if (stats.size > projectIconMaxBytes) {
        return { ok: false, reason: 'too-large' };
      }

      const chunks = [];
      let total = 0;
      while (total <= projectIconMaxBytes) {
        const chunk = Buffer.alloc(Math.min(
          projectIconReadChunkBytes,
          projectIconMaxBytes + 1 - total,
        ));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }

      if (total === 0) {
        return { ok: false, reason: 'empty' };
      }
      if (total > projectIconMaxBytes) {
        return { ok: false, reason: 'too-large' };
      }
      return { ok: true, bytes: Buffer.concat(chunks, total) };
    } finally {
      await handle.close();
    }
  };

  // Bounded serve read for a stored icon (#1537): the GET handler used to
  // readFile() the candidate whole, with no stat, no size gate, and no
  // regular-file check, so an over-cap file was buffered whole and a FIFO
  // blocked the handler indefinitely. Open non-blocking, judge the handle
  // stat, and read in chunks under the same 5 MiB cap readDiscoveredIcon
  // enforces for discovered icons.
  const readStoredIcon = async (filePath) => {
    const handle = await fsPromises.open(filePath, storedIconOpenFlags(process.platform));
    try {
      const stats = await handle.stat();
      if (stats.isFile?.() === false) {
        return { ok: false, reason: 'not-regular' };
      }
      if (stats.size > projectIconMaxBytes) {
        return { ok: false, reason: 'too-large' };
      }

      const chunks = [];
      let total = 0;
      while (total <= projectIconMaxBytes) {
        const chunk = Buffer.alloc(Math.min(
          projectIconReadChunkBytes,
          projectIconMaxBytes + 1 - total,
        ));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }

      if (total > projectIconMaxBytes) {
        return { ok: false, reason: 'too-large' };
      }
      return { ok: true, bytes: Buffer.concat(chunks, total) };
    } finally {
      await handle.close();
    }
  };

  const normalizeProjectIconMime = (value) => {
    if (typeof value !== 'string') {
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

  const projectIconBaseName = (projectId) => {
    const hash = crypto.createHash('sha1').update(projectId).digest('hex');
    return `project-${hash}`;
  };

  const projectIconPathForMime = (projectId, mime) => {
    const normalizedMime = normalizeProjectIconMime(mime);
    if (!normalizedMime) {
      return null;
    }
    const ext = projectIconMimeToExtension[normalizedMime];
    return path.join(projectIconsDirPath, `${projectIconBaseName(projectId)}.${ext}`);
  };

  const projectIconPathCandidates = (projectId) => {
    const base = projectIconBaseName(projectId);
    return Object.values(projectIconMimeToExtension).map((ext) => path.join(projectIconsDirPath, `${base}.${ext}`));
  };

  const removeProjectIconFiles = async (projectId, keepPath) => {
    const candidates = projectIconPathCandidates(projectId);
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

  const parseProjectIconDataUrl = (value) => {
    if (typeof value !== 'string') {
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
      const base64 = match[2].replace(/\s+/g, '');
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

  const normalizeProjectIconThemeVariant = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'light' || normalized === 'dark') {
      return normalized;
    }
    return null;
  };

  const normalizeProjectIconColor = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!projectIconHexColorPattern.test(normalized)) {
      return null;
    }
    return normalized;
  };

  const applyProjectIconSvgTheme = (svgMarkup, themeVariant, iconColor) => {
    if (typeof svgMarkup !== 'string') {
      return svgMarkup;
    }

    const color = iconColor || projectIconThemeColors[themeVariant];
    if (!color) {
      return svgMarkup;
    }

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

  const findProjectById = (settings, projectId) => {
    const projects = sanitizeProjects(settings?.projects) || [];
    const index = projects.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return { projects, index: -1, project: null };
    }
    return { projects, index, project: projects[index] };
  };

  const scoreFaviconCandidate = (entry) => {
    const relPath = (entry.relativePath || '').replace(/\\/g, '/');
    const lowerPath = relPath.toLowerCase();
    const ext = (entry.extension || path.extname(entry.path || '').slice(1)).toLowerCase();

    // Exclude hidden folders (.local, .cache, etc.) and non-source dirs
    if (/(^|\/)\.[^/]/i.test(relPath) || /(^|\/)(tests?|fixtures?|mocks?|examples?|docs?|vendor|third_party)(\/|$)/i.test(lowerPath)) {
      return -1000;
    }

    let score = 0;

    // Format preference: SVG (vector + themeable) > PNG (lossless + alpha) > WEBP > ICO > JPG
    const extScores = {
      svg: 50,
      png: 40,
      webp: 30,
      ico: 20,
      jpg: 10,
      jpeg: 10,
    };
    score += extScores[ext] || 0;

    // Directory preference
    const segments = relPath.split('/').filter(Boolean);
    const depth = segments.length;

    if (depth === 1) {
      // Root level: favicon.ico / favicon.svg
      score += 40;
    } else if (/(^|\/)(public|static|assets|src\/assets)(\/|$)/i.test(lowerPath)) {
      // Standard frontend asset directories
      score += 30;
    }

    // Shallower directory depth preferred
    score -= Math.min(depth * 5, 25);

    // Slight length penalty as tie-breaker
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
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
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
      const requestedThemeVariant = normalizeProjectIconThemeVariant(themeQuery);
      const iconColorQuery = Array.isArray(req.query?.iconColor) ? req.query.iconColor[0] : req.query?.iconColor;
      const requestedIconColor = normalizeProjectIconColor(iconColorQuery);

      for (const iconPath of candidates) {
        try {
          const stored = await readStoredIcon(iconPath);
          if (!stored.ok) {
            if (stored.reason === 'too-large') {
              return res.status(413).json({ error: 'Project icon is too large' });
            }
            console.warn('Failed to read project icon:', new Error(`stored project icon is not a regular file: ${iconPath}`));
            return res.status(500).json({ error: 'Failed to read project icon' });
          }
          const data = stored.bytes;
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const resolvedMime = iconPath === preferredPath && metadataMime
            ? metadataMime
            : projectIconExtensionToMime[ext] || 'application/octet-stream';
          const contentType = resolvedMime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : resolvedMime;
          // Icons come from repositories. Opened as a page, an SVG would run
          // its scripts on the app's origin; the sandbox keeps it inert and
          // changes nothing where it is drawn as an <img>.
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
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
          if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
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

  app.put('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const parsed = parseProjectIconDataUrl(req.body?.dataUrl);
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
      const nextProjects = projects.map((entry) => (
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
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
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

  app.post('/api/projects/:projectId/icon/discover', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { projects, project } = findProjectById(settings, projectId);
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

      let selected = null;
      for (const candidate of filtered) {
        if (await resolveDiscoverableIconPath(candidate.path, project.path)) {
          selected = candidate;
          break;
        }
      }
      if (!selected) {
        return res.status(404).json({ error: 'No favicon found in project' });
      }

      const ext = path.extname(selected.path).slice(1).toLowerCase();
      const mime = projectIconExtensionToMime[ext] || null;
      if (!mime) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      const discovered = await readDiscoveredIcon(selected.path);
      if (!discovered.ok && discovered.reason === 'empty') {
        return res.status(400).json({ error: 'Discovered icon is empty' });
      }
      if (!discovered.ok && discovered.reason === 'too-large') {
        return res.status(400).json({ error: 'Discovered icon exceeds size limit (5 MB)' });
      }
      if (!discovered.ok && discovered.reason === 'not-regular') {
        return res.status(400).json({ error: 'Discovered icon is not a regular file' });
      }
      if (!discovered.ok && discovered.reason === 'symlink') {
        return res.status(400).json({ error: 'Discovered icon is a symbolic link' });
      }
      const { bytes } = discovered;

      const iconPath = projectIconPathForMime(projectId, mime);
      if (!iconPath) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      await fsPromises.mkdir(projectIconsDirPath, { recursive: true });
      await fsPromises.writeFile(iconPath, bytes);
      await removeProjectIconFiles(projectId, iconPath);

      const updatedAt = Date.now();
      const nextProjects = projects.map((entry) => (
        entry.id === projectId
          ? { ...entry, iconImage: { mime, updatedAt, source: 'auto' } }
          : entry
      ));
      const updatedSettings = await persistSettings({ projects: nextProjects });
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
