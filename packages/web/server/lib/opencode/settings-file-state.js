import { createFolderChangeWatch } from '../fs/folder-change-watch.js';
import { isDeepStrictEqual } from 'node:util';
import { isNotifiableSettingsKey, parsePreferencesDocument } from './settings-files.js';

export const createSettingsFileState = ({
  fsPromises, path, settingsFilePath, preferencesFilePath, sanitizeSettingsUpdate, logger = console,
}) => {
  const paths = { settings: settingsFilePath, preferences: preferencesFilePath };
  const accepted = new Map();
  const reported = new Map();
  const revisions = new Map();
  const failures = new Set();
  const contents = new Map();

  const parse = (source, text) => {
    const document = JSON.parse(text);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('Invalid settings document');
    }
    let values = document;
    if (source === 'preferences') {
      const parsed = parsePreferencesDocument(text);
      if (!parsed.ok) throw new Error('Invalid preferences document');
      values = parsed.fields;
    }
    for (const [key, entry] of Object.entries(values)) {
      if (!isNotifiableSettingsKey(key)) continue;
      const candidates = source === 'settings' ? [entry] : [
        ...('value' in entry ? [entry.value] : []),
        ...Object.values(entry.surfaces ?? {}).map(({ value }) => value),
      ];
      for (const value of candidates) {
        if (!Object.hasOwn(sanitizeSettingsUpdate({ [key]: value }), key)) {
          throw new Error('Invalid setting value');
        }
      }
    }
    return values;
  };

  const read = async (source) => {
    const revision = revisions.get(source) ?? 0;
    try {
      const text = await fsPromises.readFile(paths[source], 'utf8');
      const document = parse(source, text);
      if (revision !== (revisions.get(source) ?? 0)) {
        return { status: 'ok', document: structuredClone(accepted.get(source)), revision: revisions.get(source) };
      }
      if (contents.get(source) !== text) revisions.set(source, revision + 1);
      contents.set(source, text);
      accepted.set(source, document);
      failures.delete(source);
      return { status: 'ok', document: structuredClone(document), revision: revisions.get(source) };
    } catch (error) {
      if (revision !== (revisions.get(source) ?? 0)) {
        return { status: 'ok', document: structuredClone(accepted.get(source)), revision: revisions.get(source) };
      }
      if (error.code === 'ENOENT' && !accepted.has(source)) {
        return { status: 'missing' };
      }
      if (!failures.has(source)) {
        failures.add(source);
        logger.warn(`Could not read ${path.basename(paths[source])}; keeping its last valid settings and pausing writes.`);
      }
      return { status: 'failed', document: structuredClone(accepted.get(source)) };
    }
  };

  const acknowledge = (filePath, text, { expectedRevision = null } = {}) => {
    const source = Object.keys(paths).find((key) => paths[key] === filePath);
    if (!source) return;
    if (expectedRevision !== null && (revisions.get(source) ?? 0) !== expectedRevision && contents.get(source) !== text) return;
    const document = parse(source, text);
    revisions.set(source, (revisions.get(source) ?? 0) + 1);
    contents.set(source, text);
    accepted.set(source, document);
    reported.set(source, document);
    failures.delete(source);
  };

  const watch = ({ onChange, pollMs = 1000, ...options }) => {
    let observed = {};
    let baseline = false;
    let stopped = false;
    const watcher = createFolderChangeWatch({
      ...options,
      root: path.dirname(settingsFilePath),
      pollMs,
      logger,
      fingerprint: async () => {
        const [settings, preferences] = await Promise.all([read('settings'), read('preferences')]);
        observed = { settings, preferences };
        if (!baseline) {
          baseline = true;
          for (const [source, result] of Object.entries(observed)) {
            if (stopped) return;
            if (result.status === 'ok') reported.set(source, result.document);
          }
        }
        return JSON.stringify(Object.fromEntries(Object.entries(observed).map(([source, result]) =>
          [source, result.status === 'ok' ? result.document : null])));
      },
      onChange: async () => {
        for (const [source, result] of Object.entries(observed)) {
          if (stopped) return;
          if (result.status !== 'ok') continue;
          if (result.revision !== revisions.get(source)) continue;
          const changedKeys = getPendingChangedKeys(source);
          if (changedKeys.length > 0) await onChange({ source, changedKeys });
          if (!stopped && result.revision === revisions.get(source)) reported.set(source, result.document);
        }
      },
      timers: options.timers ?? globalThis,
      fsWatch: options.fsWatch,
    });
    return { ...watcher, stop: () => { stopped = true; watcher.stop(); } };
  };

  const readReported = (source) => structuredClone(reported.get(source));
  const getRevision = (source) => revisions.get(source) ?? 0;
  const getPendingChangedKeys = (source) => {
    const previous = reported.get(source) ?? {};
    const current = accepted.get(source) ?? {};
    return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
      .filter((key) => isNotifiableSettingsKey(key) && !isDeepStrictEqual(previous[key], current[key]));
  };
  const hasUnreportedChanges = (source) => reported.has(source) && accepted.has(source)
    && !isDeepStrictEqual(reported.get(source), accepted.get(source));
  return { read, acknowledge, watch, readReported, hasUnreportedChanges, getRevision, getPendingChangedKeys };
};
