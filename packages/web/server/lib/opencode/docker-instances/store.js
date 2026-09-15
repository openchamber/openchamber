/**
 * Persistent registry for OpenChamber-managed Docker OpenCode instances.
 *
 * Owns its own JSON file next to the other OpenChamber data files (same
 * pattern as `message-queue.json`) — it never writes into the user's OpenCode
 * config tree, and deleting the file is a complete uninstall of the registry.
 *
 * Record shape (all fields authored here; unknown persisted fields survive
 * round-trips so older/newer builds never destroy each other's data):
 * {
 *   id, label, image, containerId, containerName, port,
 *   workspaceHostPath, workspaceContainerPath, mappingRules,
 *   sharing: { config, skills, credentials, skillsHostDir },
 *   lifecycleState, lastError, resourceJournal, createdAt, updatedAt
 * }
 */

const DOCKER_INSTANCE_STATES = Object.freeze([
  'creating',
  'starting',
  'probing',
  'running',
  'stopped',
  'error',
  'removing',
  'removal-failed',
]);

const STORE_VERSION = 1;

const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeRecord = (raw, now) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = asTrimmedString(raw.id);
  if (!id) return null;
  const sharing = raw.sharing && typeof raw.sharing === 'object' ? raw.sharing : {};
  return {
    id,
    label: asTrimmedString(raw.label) || id,
    image: asTrimmedString(raw.image),
    containerId: asTrimmedString(raw.containerId) || null,
    containerName: asTrimmedString(raw.containerName),
    port: Number.isSafeInteger(raw.port) && raw.port > 0 ? raw.port : null,
    workspaceHostPath: asTrimmedString(raw.workspaceHostPath),
    workspaceContainerPath: asTrimmedString(raw.workspaceContainerPath) || '/workspace',
    mappingRules: Array.isArray(raw.mappingRules)
      ? raw.mappingRules
        .map((rule) => ({
          hostPrefix: asTrimmedString(rule?.hostPrefix),
          remotePrefix: asTrimmedString(rule?.remotePrefix),
        }))
        .filter((rule) => rule.hostPrefix && rule.remotePrefix)
      : [],
    sharing: {
      config: sharing.config === true,
      skills: sharing.skills === true,
      credentials: sharing.credentials === true,
      skillsHostDir: asTrimmedString(sharing.skillsHostDir) || null,
    },
    lifecycleState: DOCKER_INSTANCE_STATES.includes(raw.lifecycleState) ? raw.lifecycleState : 'error',
    lastError: asTrimmedString(raw.lastError) || null,
    resourceJournal: Array.isArray(raw.resourceJournal)
      ? raw.resourceJournal
        .map((entry) => ({
          type: asTrimmedString(entry?.type),
          ref: asTrimmedString(entry?.ref),
        }))
        .filter((entry) => entry.type && entry.ref)
      : [],
    createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : now,
  };
};

/**
 * @param {object} deps
 * @param {string} deps.filePath - absolute path of `docker-instances.json`.
 * @param {object} deps.fsPromises - node:fs/promises implementation.
 * @param {object} [deps.logger]
 */
export const createDockerInstanceStore = ({ filePath, fsPromises, logger = console }) => {
  const emptyState = () => ({ version: STORE_VERSION, instances: [], activeInstanceId: null });

  let writeLock = Promise.resolve();

  const readStateFromDisk = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return emptyState();
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('non-object payload');
      }
      const now = Date.now();
      const instances = (Array.isArray(parsed.instances) ? parsed.instances : [])
        .map((entry) => normalizeRecord(entry, now))
        .filter(Boolean);
      const activeInstanceId = typeof parsed.activeInstanceId === 'string' && parsed.activeInstanceId
        && instances.some((instance) => instance.id === parsed.activeInstanceId)
        ? parsed.activeInstanceId
        : null;
      return { version: STORE_VERSION, instances, activeInstanceId };
    } catch (error) {
      logger.warn?.(`[docker-instances] Registry file unreadable, starting clean (${error.message}). Copy saved aside if possible.`);
      return emptyState();
    }
  };

  const writeStateToDisk = async (state) => {
    const directory = filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    await fsPromises.mkdir(directory, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsPromises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fsPromises.rename(tmp, filePath);
  };

  const mutate = (mutator) => {
    const run = writeLock.then(async () => {
      const state = await readStateFromDisk();
      const result = await mutator(state);
      await writeStateToDisk(state);
      return result;
    });
    writeLock = run.then(() => {}, () => {});
    return run;
  };

  return {
    async list() {
      const state = await readStateFromDisk();
      return state.instances;
    },

    async get(id) {
      const state = await readStateFromDisk();
      return state.instances.find((instance) => instance.id === id) ?? null;
    },

    async getActiveInstanceId() {
      const state = await readStateFromDisk();
      return state.activeInstanceId;
    },

    /** Inserts or replaces one record and returns the stored record. */
    async upsert(record) {
      const normalized = normalizeRecord(record, Date.now());
      if (!normalized) {
        throw new Error('Invalid docker instance record');
      }
      return mutate((state) => {
        const index = state.instances.findIndex((entry) => entry.id === normalized.id);
        if (index >= 0) {
          state.instances[index] = { ...state.instances[index], ...normalized };
        } else {
          state.instances.push(normalized);
        }
        return state.instances.find((entry) => entry.id === normalized.id);
      });
    },

    /** Patches one record via updater; updater returning null deletes it. */
    async update(id, updater) {
      return mutate((state) => {
        const index = state.instances.findIndex((entry) => entry.id === id);
        if (index === -1) return null;
        const current = state.instances[index];
        const next = updater({ ...current });
        if (next === null) {
          state.instances.splice(index, 1);
          if (state.activeInstanceId === id) state.activeInstanceId = null;
          return null;
        }
        const normalized = normalizeRecord({ ...current, ...next, id }, Date.now());
        state.instances[index] = normalized ?? current;
        return state.instances[index];
      });
    },

    async remove(id) {
      return mutate((state) => {
        const index = state.instances.findIndex((entry) => entry.id === id);
        if (index === -1) return false;
        state.instances.splice(index, 1);
        if (state.activeInstanceId === id) state.activeInstanceId = null;
        return true;
      });
    },

    async setActiveInstanceId(id) {
      return mutate((state) => {
        if (id !== null && !state.instances.some((instance) => instance.id === id)) {
          throw new Error(`Unknown docker instance: ${id}`);
        }
        state.activeInstanceId = id;
        return state.activeInstanceId;
      });
    },
  };
};
