import {
  DEFAULT_DURABLE_JSON_MAX_BYTES,
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';

// The legacy migration source is bounded by the same cap as the store
// it migrates into: the durable-store default the managed file's own
// reader enforces. A larger legacy file could never be re-read once
// migrated, so refusing it at migration time is the managed store's
// own bound applied one step earlier, not a new, unrelated cap (#1692).
export const LEGACY_NAMED_TUNNELS_MAX_BYTES = DEFAULT_DURABLE_JSON_MAX_BYTES;

export const createManagedTunnelConfigRuntime = (deps) => {
  const {
    fsPromises,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();

  // Chain on both outcomes: one failed persist must not wedge every later
  // update behind a rejected lock promise.
  const enqueuePersistLock = (fn) => {
    persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.then(fn, fn);
    return persistManagedRemoteTunnelConfigLock;
  };

  const emptyConfig = () => ({ version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] });

  const sanitizeManagedRemoteTunnelConfigEntries = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    const result = [];
    const seenIds = new Set();
    const seenHostnames = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = typeof entry.token === 'string' ? entry.token.trim() : '';
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, token, updatedAt });
    }

    return result;
  };

  // This store rides the shared durable-store primitive (design #976):
  // the strict reader, the preserve-aside step, and the mode-explicit
  // atomic write all come from lib/shared/durable-json-store.js, with
  // this store's fsPromises surface injected so the test seam is the one
  // it always had. The value judgement stays this store's own: the file
  // is a JSON object (its `tunnels` entries are sanitized from there);
  // anything else is as malformed as unparseable bytes. The parse error
  // itself is never logged or attached: Node's JSON.parse messages quote
  // the file content, and this file holds tunnel tokens. An empty file
  // now reads as missing per the primitive contract instead of being
  // preserved as corrupt.
  const storeOptions = { fs: fsPromises, validateValue: isJsonObject };

  const configFromValue = (value) => ({
    version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
    tunnels: sanitizeManagedRemoteTunnelConfigEntries(value.tunnels),
  });

  // One strict read of the managed file, in the primitive's answers:
  // 'valid' (with the sanitized config), 'missing' (absent or empty),
  // 'malformed' (unparseable or not a config object), or 'error' (a read
  // failure other than absence, with the error kept for the caller to
  // warn about or refuse on).
  const readStoreFile = async () => {
    let result;
    try {
      result = await readDurableJsonFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, storeOptions);
    } catch (error) {
      return { state: 'error', error };
    }
    if (result.state === 'valid') {
      return { state: 'valid', config: configFromValue(result.value) };
    }
    return { state: result.state };
  };

  // A torn or otherwise unparseable config file holds tunnel tokens, not
  // an empty store: the primitive moves its bytes aside before any later
  // write can overwrite them, under the collision-proof preserved name,
  // re-reading and re-judging the on-disk bytes first so a valid
  // replacement another process saved meanwhile is left in place
  // ('replaced') rather than renamed away. Answers 'preserved',
  // 'replaced', 'missing' (the file vanished or is empty now), or
  // 'failed' — the fail-closed answer, on which an update must refuse.
  const preserveCorruptFile = async () => {
    const preservation = await preserveMalformedJsonFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, storeOptions);
    if (preservation.preserved) {
      console.warn(
        `Failed to read managed remote tunnel config file: preserved the unreadable file at ${preservation.preservedPath}:`,
        new Error('the managed remote tunnel config file does not contain a config object'),
      );
      return 'preserved';
    }
    if (preservation.outcome === 'replaced' || preservation.outcome === 'missing') {
      return preservation.outcome;
    }
    console.warn('Failed to preserve the unreadable managed remote tunnel config file');
    return 'failed';
  };

  // Bounded, handle-judged read of the legacy named-tunnels file
  // (#1692), through the same durable-store primitive as the managed
  // file: opened once and judged from the handle (a non-regular file
  // is refused, and the primitive's O_NONBLOCK open keeps a FIFO from
  // wedging the persist lock this migration runs under), with the cap
  // enforced in flight. No validateValue: the legacy parse semantics
  // are unchanged (any JSON value is accepted and its `tunnels`
  // entries sanitized, exactly as the old whole-file read + JSON.parse
  // did). An empty legacy file answers 'missing', per the primitive's
  // contract. A coded refusal (over-cap, non-regular) or any other
  // read failure answers 'error' here so the migration can degrade.
  const readLegacyFile = async () => {
    try {
      return await readDurableJsonFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, {
        fs: fsPromises,
        maxBytes: LEGACY_NAMED_TUNNELS_MAX_BYTES,
      });
    } catch (error) {
      return { state: 'error', error };
    }
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data) => {
    await writeDurableJsonFile(
      CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
      JSON.stringify(data, null, 2),
      { fs: fsPromises, mode: 0o600 },
    );
  };

  // Legacy migration, with the persist lock already held. Migration writes
  // the managed file, so it must be serialized with config updates exactly
  // like any other persist: a bare read that finds the managed file absent
  // (for example in the window after a corrupt file was preserved aside)
  // must not migrate outside the lock, or its stale legacy write can land
  // after an in-flight upsert and overwrite the newly saved token. The
  // managed file is therefore re-checked before anything is written: if an
  // update landed while this migration waited for the lock, that state is
  // the answer and no migration write happens at all.
  const migrateManagedRemoteTunnelConfigFromLegacyFileLocked = async () => {
    const current = await readStoreFile();
    if (current.state === 'valid') {
      return current.config;
    }
    if (current.state === 'malformed') {
      const outcome = await preserveCorruptFile();
      if (outcome !== 'preserved') {
        // The file may have changed since validation (another process
        // saved valid state): that state is the answer, not a refusal.
        const latest = await readStoreFile();
        if (latest.state === 'valid') {
          return latest.config;
        }
        if (outcome !== 'missing' || latest.state !== 'missing') {
          throw new Error(
            `Refusing to overwrite the unreadable managed remote tunnel config file at ${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}: it could not be preserved`,
          );
        }
        // Vanished or emptied before preservation could reread it: there
        // is nothing left to protect, so fall through to the legacy
        // migration below instead of refusing.
      }
      // Preserved aside: fall through to the legacy migration, which
      // writes a fresh managed file from the legacy one if it exists.
    } else if (current.state === 'error') {
      console.warn('Failed to read managed remote tunnel config file:', current.error);
      return emptyConfig();
    }
    const legacy = await readLegacyFile();
    if (legacy.state === 'missing') {
      return emptyConfig();
    }
    if (legacy.state === 'valid') {
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(legacy.value?.tunnels),
      };
      try {
        await writeManagedRemoteTunnelConfigToDisk(migrated);
      } catch (error) {
        console.warn('Failed to migrate legacy named tunnel config file:', error);
        return emptyConfig();
      }
      return migrated;
    }
    // Malformed, over-cap, non-regular, or unreadable: degrade exactly
    // as an unreadable legacy file always has (empty config, a warning,
    // nothing written over anything) and return promptly, so the
    // persist lock is never wedged. The warning never carries a parse
    // error: JSON.parse messages quote the file content, and this file
    // holds tunnel tokens; the primitive's coded refusals name only
    // the path, the size, and the limit.
    console.warn(
      'Failed to migrate legacy named tunnel config file:',
      legacy.state === 'malformed'
        ? new Error('the legacy named tunnel config file does not contain valid JSON')
        : legacy.error,
    );
    return emptyConfig();
  };

  // Locked migration on the read paths degrades to an empty config when the
  // fail-closed migration refuses (an unpreservable corrupt file): a read
  // never writes over it anyway. The update path calls the Locked variant
  // directly so the refusal propagates and the update does not overwrite.
  const migrateLockedOrEmpty = async () => {
    try {
      return await migrateManagedRemoteTunnelConfigFromLegacyFileLocked();
    } catch {
      return emptyConfig();
    }
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () =>
    enqueuePersistLock(migrateLockedOrEmpty);

  const readManagedRemoteTunnelConfigFromDisk = async () => {
    const first = await readStoreFile();
    if (first.state === 'valid') {
      return first.config;
    }
    if (first.state === 'missing') {
      return migrateManagedRemoteTunnelConfigFromLegacyFile();
    }
    if (first.state === 'error') {
      console.warn('Failed to read managed remote tunnel config file:', first.error);
      return emptyConfig();
    }
    // Malformed. The bytes above are stale the moment the read returns: a
    // concurrent update may already have preserved the corrupt file and
    // saved valid state in its place, and renaming the path now would move
    // that saved state aside. Re-validate under the persist lock before
    // preserving anything; if an update landed in between, its state is
    // the answer.
    return enqueuePersistLock(async () => {
      const current = await readStoreFile();
      if (current.state === 'valid') {
        return current.config;
      }
      if (current.state === 'missing') {
        return migrateLockedOrEmpty();
      }
      if (current.state === 'error') {
        console.warn('Failed to read managed remote tunnel config file:', current.error);
        return emptyConfig();
      }
      const outcome = await preserveCorruptFile();
      if (outcome === 'preserved') {
        return emptyConfig();
      }
      // Changed since validation: return the current state if it is
      // readable now instead of reporting an empty store.
      const latest = await readStoreFile();
      if (latest.state === 'valid') {
        return latest.config;
      }
      if (latest.state === 'missing' && outcome === 'missing') {
        // Vanished or emptied before preservation could reread it: take
        // the same legacy migration the missing-file read above takes. A
        // 'failed' preservation must not take this path: valid bytes may
        // sit under the preserve name, and a read degrades to empty
        // rather than resurrecting the legacy file over them.
        return migrateLockedOrEmpty();
      }
      return emptyConfig();
    });
  };

  // Read on the update path, already serialized under the persist lock: a
  // corrupt file is preserved before the mutation overwrites it, and if it
  // cannot be preserved the update refuses rather than discarding tokens.
  const readConfigForUpdate = async () => {
    const first = await readStoreFile();
    if (first.state === 'valid') {
      return first.config;
    }
    if (first.state === 'missing') {
      return migrateManagedRemoteTunnelConfigFromLegacyFileLocked();
    }
    if (first.state === 'error') {
      // A non-ENOENT read failure (EIO, EACCES, ...) leaves the on-disk
      // state unknown: treating it as empty and writing the mutation over
      // it would silently discard every stored token, the same loss the
      // unreadable-file branch below refuses. Read paths may degrade to
      // empty; the update path must not.
      throw new Error(
        `Refusing to overwrite the managed remote tunnel config file at ${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}: it could not be read`,
        { cause: first.error },
      );
    }
    const outcome = await preserveCorruptFile();
    if (outcome === 'preserved') {
      return emptyConfig();
    }
    // Changed since validation: proceed from the current state if it is
    // readable now. A file that vanished or emptied before preservation
    // could reread it ('missing') has nothing left to protect, so the
    // update takes the same legacy migration the missing-file read
    // takes. Any other outcome refuses: on 'failed' the displaced valid
    // bytes may sit under the preserve name, and writing from an empty
    // base would silently drop them.
    const latest = await readStoreFile();
    if (latest.state === 'valid') {
      return latest.config;
    }
    if (latest.state === 'missing' && outcome === 'missing') {
      return migrateManagedRemoteTunnelConfigFromLegacyFileLocked();
    }
    throw new Error(
      `Refusing to overwrite the unreadable managed remote tunnel config file at ${CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH}: it could not be preserved`,
    );
  };

  const updateManagedRemoteTunnelConfig = async (mutate) =>
    enqueuePersistLock(async () => {
      const current = await readConfigForUpdate();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });

  const syncManagedRemoteTunnelConfigWithPresets = async (presets) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }) => {
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedToken = token.trim();
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }) => {
    const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId.token;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname.token;
      }
    }

    return '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
  };
};
