import { createFolderChangeWatch } from '../fs/folder-change-watch.js';
import { isDeepStrictEqual } from 'node:util';
import { isNotifiableSettingsKey, parsePreferencesDocument } from './settings-files.js';
import type { PreferenceFields } from './settings-files.js';
import type { SettingsDocument, createSettingsHelpers } from './settings-helpers.js';
import type { FolderWatchTimer, FolderWatchTimers } from '../fs/folder-change-watch.js';
import type fsModule from 'node:fs/promises';
import type pathModule from 'node:path';

type SettingsFileSource = 'settings' | 'preferences';
export class SettingsWriteConflict extends Error {}

export interface SettingsFileChange {
  source: SettingsFileSource;
  changedKeys: string[];
}
type FileReadResult<Document> =
  | { status: 'missing'; document?: undefined; revision?: undefined; missing?: undefined }
  | { status: 'failed'; document: Document | undefined; revision?: undefined; missing: boolean }
  | { status: 'ok'; document: Document; revision: number; missing?: boolean };
interface SettingsFileStateOptions {
  fsPromises: Pick<typeof fsModule, 'readFile'>;
  path: Pick<typeof pathModule, 'dirname' | 'basename'>;
  settingsFilePath: string;
  preferencesFilePath: string;
  sanitizeSettingsUpdate: ReturnType<typeof createSettingsHelpers>['sanitizeSettingsUpdate'];
  logger?: Pick<Console, 'warn'>;
}
type SettingsWatchOptions<Timer extends FolderWatchTimer> = {
  onChange: (change: SettingsFileChange) => void | Promise<void>;
  pollMs?: number;
  timers?: FolderWatchTimers<Timer>;
  fsWatch?: Parameters<typeof createFolderChangeWatch>[0]['fsWatch'];
};
const isSettingsDocument = (value: unknown): value is SettingsDocument =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasErrorCode = (value: unknown): value is { code?: unknown } =>
  Boolean(value) && typeof value === 'object';

export const createSettingsFileState = ({
  fsPromises, path, settingsFilePath, preferencesFilePath, sanitizeSettingsUpdate, logger = console,
}: SettingsFileStateOptions) => {
  const paths = { settings: settingsFilePath, preferences: preferencesFilePath };
  const accepted = new Map<SettingsFileSource, SettingsDocument | PreferenceFields>();
  const reported = new Map<SettingsFileSource, SettingsDocument | PreferenceFields>();
  const revisions = new Map<SettingsFileSource, number>();
  const failures = new Set<SettingsFileSource>();
  const contents = new Map<SettingsFileSource, string>();

  const validateValue = (key: string, value: SettingsDocument[string]) => {
    if (!Object.hasOwn(sanitizeSettingsUpdate({ [key]: value }), key)) {
      throw new Error('Invalid setting value');
    }
  };
  const parse = (source: SettingsFileSource, text: string) => {
    const document: unknown = JSON.parse(text);
    if (!isSettingsDocument(document)) {
      throw new Error('Invalid settings document');
    }
    if (source === 'preferences') {
      const parsed = parsePreferencesDocument(text);
      if (!parsed.ok) throw new Error('Invalid preferences document');
      for (const [key, entry] of Object.entries(parsed.fields)) {
        if (!isNotifiableSettingsKey(key)) continue;
        if ('value' in entry) validateValue(key, entry.value);
        for (const own of Object.values(entry.surfaces ?? {})) {
          validateValue(key, own.value);
        }
      }
      return parsed.fields;
    }
    for (const [key, value] of Object.entries(document)) {
      if (isNotifiableSettingsKey(key)) validateValue(key, value);
    }
    return document;
  };

  function read(source: 'settings'): Promise<FileReadResult<SettingsDocument>>;
  function read(source: 'preferences'): Promise<FileReadResult<PreferenceFields>>;
  function read(source: SettingsFileSource): Promise<FileReadResult<SettingsDocument | PreferenceFields>>;
  async function read(source: SettingsFileSource): Promise<FileReadResult<SettingsDocument | PreferenceFields>> {
    const revision = revisions.get(source) ?? 0;
    try {
      const text = await fsPromises.readFile(paths[source], 'utf8');
      const document = parse(source, text);
      if (revision !== (revisions.get(source) ?? 0)) {
        const latest = accepted.get(source);
        return latest === undefined ? { status: 'missing' } : { status: 'ok', document: structuredClone(latest), revision: revisions.get(source) ?? 0 };
      }
      if (contents.get(source) !== text) revisions.set(source, revision + 1);
      contents.set(source, text);
      accepted.set(source, document);
      failures.delete(source);
      return { status: 'ok', document: structuredClone(document), revision: revisions.get(source) ?? 0 };
    } catch (error) {
      if (revision !== (revisions.get(source) ?? 0)) {
        const latest = accepted.get(source);
        return latest === undefined ? { status: 'missing' } : { status: 'ok', document: structuredClone(latest), revision: revisions.get(source) ?? 0 };
      }
      const missing = hasErrorCode(error) && error.code === 'ENOENT';
      if (missing && !accepted.has(source)) {
        return { status: 'missing' };
      }
      if (!failures.has(source)) {
        failures.add(source);
        logger.warn(missing
          ? `${path.basename(paths[source])} is missing; keeping its last valid settings until the next save restores it.`
          : `Could not read ${path.basename(paths[source])}; keeping its last valid settings and pausing writes.`);
      }
      return { status: 'failed', document: structuredClone(accepted.get(source)), missing };
    }
  }

  function readForWrite(source: 'settings'): Promise<FileReadResult<SettingsDocument>>;
  function readForWrite(source: 'preferences'): Promise<FileReadResult<PreferenceFields>>;
  function readForWrite(source: SettingsFileSource): Promise<FileReadResult<SettingsDocument | PreferenceFields>>;
  async function readForWrite(source: SettingsFileSource): Promise<FileReadResult<SettingsDocument | PreferenceFields>> {
    const result = await read(source);
    if (result.status !== 'failed' || !result.missing || result.document === undefined) return result;
    return { status: 'ok', document: result.document, revision: getRevision(source), missing: true };
  }

  const acknowledge = (filePath: string, text: string, { expectedRevision = null }: { expectedRevision?: number | null } = {}) => {
    const source = (['settings', 'preferences'] as const).find((key) => paths[key] === filePath);
    if (!source) return;
    if (expectedRevision !== null && (revisions.get(source) ?? 0) !== expectedRevision && contents.get(source) !== text) return;
    const document = parse(source, text);
    revisions.set(source, (revisions.get(source) ?? 0) + 1);
    contents.set(source, text);
    accepted.set(source, document);
    reported.set(source, document);
    failures.delete(source);
  };

  const watch = <Timer extends FolderWatchTimer = ReturnType<typeof setTimeout>>({ onChange, pollMs = 1000, ...options }: SettingsWatchOptions<Timer>) => {
    let observed: {
      settings: FileReadResult<SettingsDocument>;
      preferences: FileReadResult<PreferenceFields>;
    } | null = null;
    let baseline = false;
    let stopped = false;
    const watcher = createFolderChangeWatch({
      fsWatch: options.fsWatch,
      root: path.dirname(settingsFilePath),
      pollMs,
      logger,
      fingerprint: async () => {
        const [settings, preferences] = await Promise.all([read('settings'), read('preferences')]);
        observed = { settings, preferences };
        if (!baseline) {
          baseline = true;
          for (const source of ['settings', 'preferences'] as const) {
            const result = observed[source];
            if (stopped) return '';
            if (result?.status === 'ok') reported.set(source, result.document);
          }
        }
        return JSON.stringify({
          settings: settings.status === 'ok' ? settings.document : null,
          preferences: preferences.status === 'ok' ? preferences.document : null,
        });
      },
      onChange: async () => {
        if (!observed) return;
        for (const source of ['settings', 'preferences'] as const) {
          const result = observed[source];
          if (stopped) return;
          if (result?.status !== 'ok') continue;
          if (result.revision !== revisions.get(source)) continue;
          const changedKeys = getPendingChangedKeys(source);
          if (changedKeys.length > 0) await onChange({ source, changedKeys });
          if (!stopped && result.revision === revisions.get(source)) reported.set(source, result.document);
        }
      },
      timers: options.timers,
    });
    return { ...watcher, stop: () => { stopped = true; watcher.stop(); } };
  };

  function readReported(source: 'settings'): SettingsDocument | undefined;
  function readReported(source: 'preferences'): PreferenceFields | undefined;
  function readReported(source: SettingsFileSource) { return structuredClone(reported.get(source)); }
  const getRevision = (source: SettingsFileSource) => revisions.get(source) ?? 0;
  const getPendingChangedKeys = (source: SettingsFileSource) => {
    const previous = reported.get(source) ?? {};
    const current = accepted.get(source) ?? {};
    return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
      .filter((key) => isNotifiableSettingsKey(key) && !isDeepStrictEqual(previous[key], current[key]));
  };
  const hasUnreportedChanges = (source: SettingsFileSource) => reported.has(source) && accepted.has(source)
    && !isDeepStrictEqual(reported.get(source), accepted.get(source));
  const markReported = (source: SettingsFileSource, revision: number) => {
    const document = accepted.get(source);
    if (document !== undefined && getRevision(source) === revision) reported.set(source, document);
  };
  const isUnreadable = (source: SettingsFileSource) => failures.has(source);
  return { read, readForWrite, acknowledge, watch, readReported, hasUnreportedChanges, getRevision, getPendingChangedKeys, markReported, isUnreadable };
};
