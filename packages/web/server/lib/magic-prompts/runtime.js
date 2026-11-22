import {
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';

const FILE_VERSION = 1;
const MAX_PROMPT_TEXT_LENGTH = 200_000;
const PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const isVisiblePromptID = (id) => typeof id === 'string' && id.endsWith('.visible');

const hasOwn = (input, key) => Object.prototype.hasOwnProperty.call(input, key);

const sanitizeOverrides = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key) || typeof entry !== 'string') {
      continue;
    }
    next[key] = entry;
  }
  return next;
};

export const createMagicPromptRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    filePath,
  } = dependencies;

  let writeLock = Promise.resolve();

  const enqueueLocked = (fn) => {
    writeLock = writeLock.then(fn, fn);
    return writeLock;
  };

  const emptyState = () => ({ version: FILE_VERSION, overrides: {} });

  const stateFromParsed = (parsed) => ({
    version: FILE_VERSION,
    overrides: sanitizeOverrides(parsed?.overrides),
  });

  // This store rides the shared durable-store primitive (design #976):
  // the strict reader judges the file, the preserve helper moves a
  // malformed file aside under the collision-proof preserve name, and
  // the writer is mode-explicit. A torn or otherwise unparseable file
  // is user data, not an empty store: move its bytes aside before any
  // later write can overwrite them, and name the preserved copy so the
  // loss is recoverable. The value judgement stays the one this store
  // always made - any parsed JSON reaches stateFromParsed, which
  // tolerates every shape - so only unparseable bytes are malformed
  // here. The preserve helper re-reads and re-judges the on-disk bytes
  // before renaming anything, so a valid replacement that landed in
  // the meantime is never moved aside; a 'replaced' outcome re-reads
  // that valid file instead (bounded - repeated replacement is a race
  // no read should chase). A mutation must never overwrite bytes whose
  // preservation just failed: they are the only copy of the user's
  // overrides, so the read fails closed instead. Only call the locked
  // reader serialized with writes (persist) or re-validated under the
  // lock: the file at filePath may have been replaced by a valid write
  // since the bytes that failed to parse were read.
  const readPromptStateLocked = async (replacements = 0, failClosed = true) => {
    const result = await readDurableJsonFile(filePath, { fs: fsPromises });
    if (result.state === 'valid') return stateFromParsed(result.value);
    // The primitive collapses an absent file and an EXISTING empty or
    // whitespace-only file into the same 'missing' answer. Only the
    // absent file is the first-run case: empty bytes are unparseable,
    // and the pre-migration reader revalidated them before treating the
    // store as empty - another process sharing this file can replace
    // the empty bytes with valid state while this read is in flight,
    // and returning an empty store here would let a mutation overwrite
    // that replacement and drop its overrides (Codex, PR #1019). So a
    // 'missing' verdict goes through the preserve helper too: it
    // re-reads and re-judges the on-disk bytes, answers 'replaced' for
    // a valid replacement (re-read below), 'missing' for a truly
    // absent file (the first-run return) or for still-empty bytes
    // (which hold no overrides, so there is nothing to preserve), and
    // 'preserved' if the re-read bytes are malformed.
    const preservation = await preserveMalformedJsonFile(filePath, { fs: fsPromises });
    if (preservation.preserved) {
      console.warn(`Failed to read magic prompts file: preserved the unreadable file at ${preservation.preservedPath}`);
      return emptyState();
    }
    if (preservation.outcome === 'missing') return emptyState();
    if (preservation.outcome === 'replaced' && replacements < 3) {
      return readPromptStateLocked(replacements + 1, failClosed);
    }
    if (!failClosed) {
      console.warn('Failed to preserve the unreadable magic prompts file; returning an empty state');
      return emptyState();
    }
    throw new Error('Failed to preserve the unreadable magic prompts file; refusing to overwrite it');
  };

  const readPromptState = async () => {
    const result = await readDurableJsonFile(filePath, { fs: fsPromises });
    if (result.state === 'valid') return stateFromParsed(result.value);
    // The bytes above are stale the moment the read returns: a
    // concurrent write may already have preserved the malformed file
    // and saved valid state in its place. Re-validate under the write
    // lock before preserving anything; if a write landed in between,
    // its state is the answer, not an empty store.
    return enqueueLocked(() => readPromptStateLocked(0, false));
  };

  const writePromptState = async (state) => {
    // The file mode stays stated here: the primitive's writer requires
    // it, and this store never restricted its file (plain writeFile
    // under the process umask), so 0o666 keeps the effective mode it
    // always had. Prompt overrides are user data, not secrets.
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await writeDurableJsonFile(filePath, JSON.stringify(state, null, 2), { fs: fsPromises, mode: 0o666 });
  };

  const persist = async (mutator) => enqueueLocked(async () => {
    const current = await readPromptStateLocked();
    const next = await mutator(current);
    await writePromptState(next);
    return next;
  });

  const setOverride = async (id, text) => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }
    if (typeof text !== 'string') {
      throw new Error('Prompt text must be a string');
    }
    if (isVisiblePromptID(normalizedId) && text.trim().length === 0) {
      throw new Error('Visible prompt text cannot be empty');
    }
    if (text.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new Error('Prompt text is too long');
    }

    return persist(async (state) => {
      const nextOverrides = { ...state.overrides, [normalizedId]: text };
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetOverride = async (id) => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }

    return persist(async (state) => {
      if (!hasOwn(state.overrides, normalizedId)) {
        return state;
      }
      const nextOverrides = { ...state.overrides };
      delete nextOverrides[normalizedId];
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetAllOverrides = async () => {
    return persist(async () => ({ version: FILE_VERSION, overrides: {} }));
  };

  return {
    readPromptState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};
