import fs from 'fs';
import os from 'os';

import { getNpmInfo as defaultGetNpmInfo } from './npm-registry.js';
import { isExactSemver as defaultIsExactSemver, isPathSpec as defaultIsPathSpec, parseNpmSpec as defaultParseNpmSpec, parsePathSpec as defaultParsePathSpec } from './plugin-spec.js';

const ENTRY_EXISTS_CODES = new Set(['ENTRY_EXISTS', 'EEXIST']);
const FILE_EXISTS_CODES = new Set(['FILE_EXISTS', 'EEXIST']);
const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'ENOENT']);
const BAD_REQUEST_CODES = new Set(['INVALID_FILENAME', 'INVALID_SCOPE', 'INVALID_SPEC', 'EINVAL']);

export const registerPluginRoutes = (app, dependencies) => {
  const {
    resolveOptionalProjectDirectory,
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs,
    listPluginEntries,
    getPluginEntry,
    createPluginEntry,
    updatePluginEntry,
    deletePluginEntry,
    listPluginDirFiles,
    readPluginDirFile,
    writePluginDirFile,
    deletePluginDirFile,
    encodePluginId,
    decodePluginId,
    getNpmInfo = defaultGetNpmInfo,
    parseNpmSpec = defaultParseNpmSpec,
    parsePathSpec = defaultParsePathSpec,
    isExactSemver = defaultIsExactSemver,
    isPathSpec = defaultIsPathSpec,
  } = dependencies;

  const parsedKindForSpec = (spec) => (isPathSpec(spec) ? 'path' : 'npm');

  const resolveDirectory = async (req, res) => {
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) {
      res.status(400).json({ error });
      return null;
    }
    return directory || null;
  };

  const successPayload = (message) => ({
    success: true,
    requiresReload: true,
    message,
    reloadDelayMs: clientReloadDelayMs,
    reloadFailed: false,
    warning: undefined,
  });

  const completePluginMutation = async (res, operation, _noun, applyChange) => {
    applyChange();

    const pastTense = operation.replace(/ion$/, 'ed').replace(/update$/, 'updated');

    try {
      await refreshOpenCodeAfterConfigChange(`plugin ${operation}`);
      return res.json(successPayload(`Plugin ${pastTense}. Reloading interface…`));
    } catch (error) {
      console.error(`[API:plugin ${operation}] Reload failed after config write:`, error);
      return res.json({
        success: true,
        requiresReload: false,
        message: `Plugin ${pastTense}, but OpenCode reload failed.`,
        reloadDelayMs: clientReloadDelayMs,
        reloadFailed: true,
        warning: error.message || 'OpenCode reload failed after plugin config changed',
      });
    }
  };

  const validateEntryId = (id) => {
    const decoded = decodePluginId(id);
    if (decoded.prefix !== 'config') {
      const error = new Error('Plugin entry not found');
      error.code = 'NOT_FOUND';
      throw error;
    }
  };

  const validateFileId = (id) => {
    const decoded = decodePluginId(id);
    if (decoded.prefix !== 'file') {
      const error = new Error('Plugin file not found');
      error.code = 'NOT_FOUND';
      throw error;
    }
  };

  const handlePluginError = (res, error, fallbackMessage, context, existsKind = null) => {
    const code = error?.code;
    if ((existsKind === 'entry' && ENTRY_EXISTS_CODES.has(code)) || (existsKind === 'file' && FILE_EXISTS_CODES.has(code))) {
      return res.status(409).json({ error: error.message });
    }
    if (NOT_FOUND_CODES.has(code)) {
      return res.status(404).json({ error: error.message });
    }
    if (BAD_REQUEST_CODES.has(code)) {
      return res.status(400).json({ error: error.message });
    }

    console.error(context, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  app.get('/api/config/plugins', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;

      res.json({
        entries: listPluginEntries(directory),
        files: listPluginDirFiles(directory),
      });
    } catch (error) {
      console.error('[API:GET /api/config/plugins] Failed:', error);
      res.status(500).json({ error: 'Failed to list plugins' });
    }
  });

  app.get('/api/config/plugins/registry', async (req, res) => {
    try {
      const { directory, error: directoryError } = await resolveOptionalProjectDirectory(req);
      if (directoryError) {
        return res.status(400).json({ error: directoryError });
      }
      const rawSpecs = (req.query.specs || '').toString();
      const specs = rawSpecs
        ? rawSpecs.split(',').map((spec) => {
          try {
            return decodeURIComponent(spec);
          } catch {
            return spec;
          }
        }).filter((spec) => spec.length > 0)
        : [];
      const uniqueSpecs = Array.from(new Set(specs));
      if (uniqueSpecs.length > 100) {
        return res.status(400).json({ error: 'too many specs' });
      }

      const refresh = req.query.refresh === 'true';
      const npmJobs = new Map();
      const malformedSpecs = new Set();

      for (const spec of uniqueSpecs) {
        if (parsedKindForSpec(spec) !== 'npm') continue;

        const parsed = parseNpmSpec(spec);
        if (parsed.malformed) {
          malformedSpecs.add(spec);
          continue;
        }

        const job = npmJobs.get(parsed.name) || { specs: [], parsedBySpec: new Map() };
        job.specs.push(spec);
        job.parsedBySpec.set(spec, parsed);
        npmJobs.set(parsed.name, job);
      }

      const npmInfoByName = new Map();
      await Promise.all(Array.from(npmJobs.keys()).map(async (name) => {
        npmInfoByName.set(name, await getNpmInfo(name, { forceRefresh: refresh }));
      }));

      const results = [];
      for (const spec of uniqueSpecs) {
        if (malformedSpecs.has(spec)) {
          results.push({ kind: 'npm-malformed', spec, error: 'Spec syntax is malformed' });
          continue;
        }

        if (parsedKindForSpec(spec) === 'path') {
          const { absolutePath } = parsePathSpec(spec, { homedir: os.homedir(), cwd: directory || os.homedir() });
          try {
            fs.statSync(absolutePath);
          } catch {
            results.push({ kind: 'path-missing', spec, absolutePath });
            continue;
          }

          try {
            fs.accessSync(absolutePath, fs.constants.R_OK);
            results.push({ kind: 'path-ok', spec, absolutePath });
          } catch {
            results.push({ kind: 'path-unreadable', spec, absolutePath });
          }
          continue;
        }

        const parsed = parseNpmSpec(spec);
        const info = npmInfoByName.get(parsed.name);
        if (!info.ok) {
          if (info.status === 404) {
            results.push({ kind: 'npm-missing-package', spec, name: parsed.name, error: info.error });
            continue;
          }

          results.push({ kind: 'npm-network', spec, error: info.status === 'network' ? info.error : `Registry returned ${info.status}` });
          continue;
        }

        const currentVersion = parsed.version;
        if (currentVersion !== null && isExactSemver(currentVersion) && !info.versions.includes(currentVersion)) {
          results.push({
            kind: 'npm-missing-version',
            spec,
            name: parsed.name,
            currentVersion,
            latestVersion: info.latest,
            versions: info.versions,
          });
          continue;
        }

        results.push({
          kind: 'npm-ok',
          spec,
          name: parsed.name,
          currentVersion,
          latestVersion: info.latest,
          versions: info.versions,
          hasUpdate: currentVersion !== null && isExactSemver(currentVersion) && currentVersion !== info.latest,
        });
      }

      return res.json({ results });
    } catch (error) {
      console.error('[API:GET /api/config/plugins/registry]', error);
      return res.status(500).json({ error: 'Failed to query npm registry' });
    }
  });

  app.get('/api/config/plugins/entry/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateEntryId(req.params.id);

      const entry = getPluginEntry(req.params.id, directory);
      if (!entry) {
        return res.status(404).json({ error: 'Plugin entry not found' });
      }
      return res.json(entry);
    } catch (error) {
      return handlePluginError(res, error, 'Failed to get plugin entry', '[API:GET /api/config/plugins/entry/:id] Failed:');
    }
  });

  app.post('/api/config/plugins/entry', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;

      await completePluginMutation(res, 'entry creation', 'entry', () => {
        createPluginEntry({
          spec: req.body?.spec,
          options: req.body?.options,
          scope: req.body?.scope,
        }, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to create plugin entry', '[API:POST /api/config/plugins/entry] Failed:', 'entry');
    }
  });

  app.patch('/api/config/plugins/entry/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateEntryId(req.params.id);

      await completePluginMutation(res, 'entry update', 'entry', () => {
        updatePluginEntry(req.params.id, {
          spec: req.body?.spec,
          options: req.body?.options,
        }, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to update plugin entry', '[API:PATCH /api/config/plugins/entry/:id] Failed:', 'entry');
    }
  });

  app.delete('/api/config/plugins/entry/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateEntryId(req.params.id);

      await completePluginMutation(res, 'entry deletion', 'entry', () => {
        deletePluginEntry(req.params.id, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to delete plugin entry', '[API:DELETE /api/config/plugins/entry/:id] Failed:', 'entry');
    }
  });

  app.get('/api/config/plugins/file/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateFileId(req.params.id);

      const file = readPluginDirFile(req.params.id, directory);
      if (!file) {
        return res.status(404).json({ error: 'Plugin file not found' });
      }
      return res.json(file);
    } catch (error) {
      return handlePluginError(res, error, 'Failed to read plugin file', '[API:GET /api/config/plugins/file/:id] Failed:');
    }
  });

  app.post('/api/config/plugins/file', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      const id = encodePluginId('file', `${req.body?.scope || 'user'}:${req.body?.fileName || ''}`);

      await completePluginMutation(res, 'file creation', 'file', () => {
        validateFileId(id);
        writePluginDirFile({
          fileName: req.body?.fileName,
          content: req.body?.content,
          scope: req.body?.scope,
        }, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to create plugin file', '[API:POST /api/config/plugins/file] Failed:', 'file');
    }
  });

  app.put('/api/config/plugins/file/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateFileId(req.params.id);

      const existing = readPluginDirFile(req.params.id, directory);
      if (!existing) {
        return res.status(404).json({ error: 'Plugin file not found' });
      }

      await completePluginMutation(res, 'file update', 'file', () => {
        writePluginDirFile({
          fileName: existing.fileName,
          content: req.body?.content,
          scope: existing.scope,
        }, directory, { overwrite: true });
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to update plugin file', '[API:PUT /api/config/plugins/file/:id] Failed:', 'file');
    }
  });

  app.delete('/api/config/plugins/file/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateFileId(req.params.id);

      await completePluginMutation(res, 'file deletion', 'file', () => {
        deletePluginDirFile(req.params.id, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to delete plugin file', '[API:DELETE /api/config/plugins/file/:id] Failed:', 'file');
    }
  });
};
