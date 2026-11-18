import fs from 'fs';
import os from 'os';

import { getNpmInfo as defaultGetNpmInfo } from '../npm/npm-registry.js';
import { isExactSemver as defaultIsExactSemver, parseNpmSpec as defaultParseNpmSpec, parsePathSpec as defaultParsePathSpec, parsedKindForSpec as defaultParsedKindForSpec } from './plugin-spec.js';
import { buildAppliedResponse } from './config-mutation-response.js';
import { isString } from '../shared/object-guards.js';
import type { NpmLookupResult } from '../npm/npm-registry.js';
import type { ProjectDirectoryResolution } from '../projects/project-directory-runtime.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { ParsedNpmSpec } from './plugin-spec.js';
import type { PluginSwitchStore } from './plugin-switches.js';
import type { PluginInput, PluginFileInput } from './plugins.js';
import type { JsonValue } from '../shared/json-values.js';

type Directory = ProjectDirectoryResolution['directory'];
type PluginListing = { switchState?: string } | { fileName: string; switchState?: never };
type PluginSwitchResult = { enabled: boolean; resource: string; changed: boolean };
type PluginEntryInput = PluginInput;

export interface PluginRouteDependencies {
  resolveOptionalProjectDirectory(request: Request): Promise<Pick<ProjectDirectoryResolution, 'directory' | 'error'>>;
  listPluginEntries(directory: Directory, store: PluginSwitchStore | null): PluginListing[];
  getPluginEntry(id: string | undefined, directory: Directory, store: PluginSwitchStore | null): PluginListing | null;
  createPluginEntry(entry: PluginEntryInput, directory: Directory): void;
  updatePluginEntry(id: string, updates: PluginEntryInput, directory: Directory): void;
  deletePluginEntry(id: string | undefined, directory: Directory): void;
  setPluginEntryEnabled(id: string | undefined, enabled: boolean, directory: Directory, store: PluginSwitchStore | null): PluginSwitchResult;
  setPluginFileEnabled(id: string | undefined, enabled: boolean, directory: Directory, store: PluginSwitchStore | null): PluginSwitchResult;
  listPluginDirFiles(directory: Directory, store: PluginSwitchStore | null): PluginListing[];
  readPluginDirFile(id: string | undefined, directory: Directory): { fileName: string; scope: string; content: string } | null;
  writePluginDirFile(file: PluginFileInput, directory: Directory, options?: { overwrite?: boolean }): void;
  deletePluginDirFile(id: string | undefined, directory: Directory): void;
  encodePluginId(prefix: 'file', value: string): string;
  decodePluginId(id: string | undefined): { prefix: string };
  pluginSwitchStore?: PluginSwitchStore | null;
  isPluginSwitchAvailable?: () => boolean;
  refreshPluginSwitches?: () => Promise<{ updated: boolean } | void>;
  getNpmInfo?: typeof defaultGetNpmInfo;
  parseNpmSpec?: typeof defaultParseNpmSpec;
  parsePathSpec?: typeof defaultParsePathSpec;
  isExactSemver?: typeof defaultIsExactSemver;
  parsedKindForSpec?: typeof defaultParsedKindForSpec;
}

type PluginRequestBody = PluginEntryInput & PluginFileInput & { enabled?: JsonValue };
const hasPluginBodyFields = (value: PluginRequestBody | null | undefined): value is PluginRequestBody => value != null;
const hasErrorFields = (value: unknown): value is { code?: unknown; message?: unknown } => value != null;
const hasCode = (codes: ReadonlySet<string>, cause: unknown): cause is { code: string; message?: unknown } =>
  hasErrorFields(cause) && isString(cause.code) && codes.has(cause.code);

const ENTRY_EXISTS_CODES = new Set(['ENTRY_EXISTS', 'EEXIST']);
const FILE_EXISTS_CODES = new Set(['FILE_EXISTS', 'EEXIST']);
const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'ENOENT']);
const BAD_REQUEST_CODES = new Set(['INVALID_FILENAME', 'INVALID_SCOPE', 'INVALID_SPEC', 'UNLOADABLE_SPEC', 'EINVAL']);
const SWITCH_REFUSED_CODES = new Set(['SWITCH_UNAVAILABLE', 'SWITCH_OVERRIDDEN']);

export const registerPluginRoutes = (app: Application, dependencies: PluginRouteDependencies) => {
  const {
    resolveOptionalProjectDirectory,
    listPluginEntries,
    getPluginEntry,
    createPluginEntry,
    updatePluginEntry,
    deletePluginEntry,
    setPluginEntryEnabled,
    setPluginFileEnabled,
    listPluginDirFiles,
    readPluginDirFile,
    writePluginDirFile,
    deletePluginDirFile,
    encodePluginId,
    decodePluginId,
    pluginSwitchStore = null,
    isPluginSwitchAvailable = () => true,
    refreshPluginSwitches = async () => ({ updated: true }),
    getNpmInfo = defaultGetNpmInfo,
    parseNpmSpec = defaultParseNpmSpec,
    parsePathSpec = defaultParsePathSpec,
    isExactSemver = defaultIsExactSemver,
    parsedKindForSpec = defaultParsedKindForSpec,
  } = dependencies;

  const resolveDirectory = async (req: Request, res: Response) => {
    const { directory, error } = await resolveOptionalProjectDirectory(req);
    if (error) {
      res.status(400).json({ error });
      return null;
    }
    return directory || null;
  };

  const completePluginMutation = async (res: Response, operation: string, _noun: 'entry' | 'file', applyChange: () => void) => {
    applyChange();

    const pastTense = operation.replace(/ion$/, 'ed').replace(/update$/, 'updated');
    return res.json(buildAppliedResponse(
      `Plugin ${pastTense}.`,
    ));
  };

  const validateEntryId = (id: string | undefined) => {
    const decoded = decodePluginId(id);
    if (decoded.prefix !== 'config') {
      const error = Object.assign(new Error('Plugin entry not found'), { code: 'NOT_FOUND' });
      throw error;
    }
  };

  const validateFileId = (id: string | undefined) => {
    const decoded = decodePluginId(id);
    if (decoded.prefix !== 'file') {
      const error = Object.assign(new Error('Plugin file not found'), { code: 'NOT_FOUND' });
      throw error;
    }
  };

  const switchable = (item: PluginListing) => (isPluginSwitchAvailable() ? item : { ...item, switchState: 'unavailable' });

  const answerSwitchChange = async (res: Response, message: string, result: PluginSwitchResult) => {
    let refreshed;
    try {
      refreshed = await refreshPluginSwitches();
    } catch (error) {
      console.warn('[API] Failed to rewrite the managed OpenCode config for a plugin switch:', error);
      return res.json({
        ...buildAppliedResponse(message),
        ...result,
        requiresReload: false,
        requiresManualRestart: true,
      });
    }
    const response: PluginSwitchResult & { success: boolean; message: string; requiresReload?: false; requiresManualRestart?: true } = { ...buildAppliedResponse(message), ...result };
    if (refreshed?.updated === false) {
      response.requiresReload = false;
      response.requiresManualRestart = true;
    }
    return res.json(response);
  };

  const handlePluginError = (res: Response, cause: unknown, fallbackMessage: string, context: string, existsKind: 'entry' | 'file' | null = null) => {
    const error = hasErrorFields(cause) ? cause : undefined;
    const code = error?.code;
    if (error && isString(code)) {
      if ((existsKind === 'entry' && ENTRY_EXISTS_CODES.has(code)) || (existsKind === 'file' && FILE_EXISTS_CODES.has(code))) {
        return res.status(409).json({ error: error.message });
      }
      if (NOT_FOUND_CODES.has(code)) {
        return res.status(404).json({ error: error.message });
      }
      if (BAD_REQUEST_CODES.has(code)) {
        return res.status(400).json({ error: error.message, code });
      }
    }
    console.error(context, cause);
    return res.status(500).json({ error: fallbackMessage });
  };

  app.get('/api/config/plugins', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;

      res.json({
        entries: listPluginEntries(directory, pluginSwitchStore).map(switchable),
        files: listPluginDirFiles(directory, pluginSwitchStore).map(switchable),
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
      const npmJobs = new Map<string, { specs: string[]; parsedBySpec: Map<string, ParsedNpmSpec> }>();
      const malformedSpecs = new Set();

      for (const spec of uniqueSpecs) {
        if (parsedKindForSpec(spec) !== 'npm') continue;

        const parsed = parseNpmSpec(spec);
        if ('malformed' in parsed) {
          malformedSpecs.add(spec);
          continue;
        }

        const job = npmJobs.get(parsed.name) || { specs: Array<string>(), parsedBySpec: new Map<string, ParsedNpmSpec>() };
        job.specs.push(spec);
        job.parsedBySpec.set(spec, parsed);
        npmJobs.set(parsed.name, job);
      }

      const npmInfoByName = new Map<string, NpmLookupResult>();
      await Promise.all(Array.from(npmJobs.keys()).map(async (name) => {
        npmInfoByName.set(name, await getNpmInfo(name, { forceRefresh: refresh }));
      }));

      const results = [];
      for (const spec of uniqueSpecs) {
        if (malformedSpecs.has(spec)) {
          results.push({ kind: 'npm-malformed', spec, error: 'Spec syntax is malformed' });
          continue;
        }

        if (parsedKindForSpec(spec) === 'control') continue;

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

        if (parsedKindForSpec(spec) === 'git') {
          results.push({ kind: 'git-ok', spec });
          continue;
        }

        const parsed = parseNpmSpec(spec);
        if ('malformed' in parsed) throw new TypeError();
        const info = npmInfoByName.get(parsed.name);
        if (!info) throw new TypeError();
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

      const entry = getPluginEntry(req.params.id, directory, pluginSwitchStore);
      if (!entry) {
        return res.status(404).json({ error: 'Plugin entry not found' });
      }
      return res.json(switchable(entry));
    } catch (error) {
      return handlePluginError(res, error, 'Failed to get plugin entry', '[API:GET /api/config/plugins/entry/:id] Failed:');
    }
  });

  app.post<PluginRequestBody>('/api/config/plugins/entry', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;

      await completePluginMutation(res, 'entry creation', 'entry', () => {
        const body = hasPluginBodyFields(req.body) ? req.body : undefined;
        createPluginEntry({
          spec: body?.spec,
          options: body?.options,
          scope: body?.scope,
        }, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to create plugin entry', '[API:POST /api/config/plugins/entry] Failed:', 'entry');
    }
  });

  app.patch<PluginRequestBody, { id: string }>('/api/config/plugins/entry/:id', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateEntryId(req.params.id);

      await completePluginMutation(res, 'entry update', 'entry', () => {
        const body = hasPluginBodyFields(req.body) ? req.body : undefined;
        updatePluginEntry(req.params.id, {
          spec: body?.spec,
          options: body?.options,
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

  app.put<PluginRequestBody>('/api/config/plugins/entry/:id/enabled', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      validateEntryId(req.params.id);

      const enabled = hasPluginBodyFields(req.body) ? req.body.enabled : undefined;
      if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean', code: 'INVALID_STATE' });
      }
      if (!isPluginSwitchAvailable()) {
        return res.status(409).json({
          error: 'Plugin switches apply only to the OpenCode OpenChamber starts',
          code: 'SWITCH_UNAVAILABLE',
        });
      }

      const result = setPluginEntryEnabled(req.params.id, enabled, directory, pluginSwitchStore);
      return answerSwitchChange(res, `Plugin ${enabled ? 'enabled' : 'disabled'}.`, result);
    } catch (error) {
      if (hasCode(SWITCH_REFUSED_CODES, error)) {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      return handlePluginError(res, error, 'Failed to change plugin state', '[API:PUT /api/config/plugins/entry/:id/enabled] Failed:', 'entry');
    }
  });

  app.put<PluginRequestBody>('/api/config/plugins/file/:id/enabled', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      const decoded = decodePluginId(req.params.id);
      if (decoded.prefix !== 'file' && decoded.prefix !== 'package' && decoded.prefix !== 'legacyPackage' && decoded.prefix !== 'legacy') {
        return res.status(404).json({ error: 'Plugin file not found' });
      }

      const enabled = hasPluginBodyFields(req.body) ? req.body.enabled : undefined;
      if (enabled !== true && enabled !== false) {
        return res.status(400).json({ error: 'enabled must be a boolean', code: 'INVALID_STATE' });
      }
      if (!isPluginSwitchAvailable()) {
        return res.status(409).json({
          error: 'Plugin switches apply only to the OpenCode OpenChamber starts',
          code: 'SWITCH_UNAVAILABLE',
        });
      }

      const result = setPluginFileEnabled(req.params.id, enabled, directory, pluginSwitchStore);
      return answerSwitchChange(res, `Plugin ${enabled ? 'enabled' : 'disabled'}.`, result);
    } catch (error) {
      if (hasCode(SWITCH_REFUSED_CODES, error)) {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      return handlePluginError(res, error, 'Failed to change plugin state', '[API:PUT /api/config/plugins/file/:id/enabled] Failed:');
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

  app.post<PluginRequestBody>('/api/config/plugins/file', async (req, res) => {
    try {
      const directory = await resolveDirectory(req, res);
      if (directory === null && res.headersSent) return;
      const body = hasPluginBodyFields(req.body) ? req.body : undefined;
      const id = encodePluginId('file', `${body?.scope || 'user'}:${body?.fileName || ''}`);

      await completePluginMutation(res, 'file creation', 'file', () => {
        validateFileId(id);
        writePluginDirFile({
          fileName: body?.fileName,
          content: body?.content,
          scope: body?.scope,
        }, directory);
      });
    } catch (error) {
      return handlePluginError(res, error, 'Failed to create plugin file', '[API:POST /api/config/plugins/file] Failed:', 'file');
    }
  });

  app.put<PluginRequestBody>('/api/config/plugins/file/:id', async (req, res) => {
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
          content: hasPluginBodyFields(req.body) ? req.body.content : undefined,
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
