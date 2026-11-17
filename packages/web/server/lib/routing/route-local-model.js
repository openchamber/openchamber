/**
 * The local interpreter: a small instruction model that answers the choice
 * questions in `route-interpreter.js`, constrained to the allowed answers by a
 * JSON grammar so it cannot reply with anything else. It is only downloaded when
 * the user asks for it in Settings, and `node-llama-cpp` is loaded lazily, so
 * OpenChamber runs without either.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The interpreter's model. `url` names one Hugging Face commit, so `sha256`
 * (the file's LFS digest at that commit) always describes the same bytes. A
 * model without a digest is never downloaded.
 */
export const LOCAL_MODEL = {
  id: 'qwen2.5-1.5b-instruct-q4_k_m',
  label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
  file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  bytes: 1117320736,
  sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
};

// A download that delivers no bytes for this long is stalled, not slow:
// the model is over a gigabyte, so the bound is on silence, not on total
// time — a slow connection that keeps delivering bytes is never cut off.
// The dictation model downloader uses the same bound and shape (#814).
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

/** Refuses a model that has no pinned digest, before anything is fetched or written. */
export const assertVerifiable = (model = LOCAL_MODEL) => {
  if (!model.sha256) {
    throw Object.assign(new Error('No checksum is pinned for the local model in this build, so it cannot be downloaded safely'), { status: 409 });
  }
};

const modelsDir = (env = process.env) => {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(base, 'openchamber', 'models');
};

export const modelPath = (env) => path.join(modelsDir(env), LOCAL_MODEL.file);

export const modelStatus = (file = modelPath(), model = LOCAL_MODEL) => {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  return {
    ...model,
    path: file,
    installed: size === model.bytes,
    downloadedBytes: size,
  };
};

/**
 * Downloads the model to a partial file. The partial file becomes the model
 * only when its size and SHA-256 both match the model's pinned values;
 * otherwise it is discarded and the error says why. A download that goes
 * silent — no response, then no bytes — for stallTimeoutMs is discarded
 * the same way, with an error that says it timed out and can be retried;
 * without that bound a half-open connection would hold the download (and
 * the Settings state that tracks it) forever.
 */
export const downloadModel = async ({ file = modelPath(), model = LOCAL_MODEL, fetchImpl = fetch, createWriteStreamImpl = fs.createWriteStream, onProgress = () => {}, stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS } = {}) => {
  if (modelStatus(file, model).installed) return modelStatus(file, model);
  assertVerifiable(model);

  // Stall bound for the whole transfer, mirroring the dictation model
  // downloader (#814): the timer is armed before the fetch (so a response
  // that never arrives counts) and re-armed on every chunk. Firing aborts
  // the fetch through its signal and settles the raced read below, so the
  // download rejects even when a body ignores its signal.
  const controller = new AbortController();
  const timeoutError = () => Object.assign(
    new Error(`The model download timed out after ${Math.round(stallTimeoutMs / 1000)} seconds without receiving data, so it was discarded; try again`),
    { status: 502 },
  );
  // Each operation races its OWN stall promise, created per call and
  // dropped when that call settles: racing every chunk against one
  // long-lived promise pins each settled race (and the chunk it carried)
  // in that promise's handler list for the whole transfer, so a healthy
  // download would retain the entire model in memory.
  let stallTimer = null;
  let rejectStalled = null;
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      const error = timeoutError();
      rejectStalled?.(error);
      controller.abort(error);
    }, stallTimeoutMs);
    stallTimer.unref?.();
  };
  const raceStall = (operation) => new Promise((resolve, reject) => {
    rejectStalled = reject;
    // Handlers stay attached after this race settles, so a late rejection
    // of the operation (the abort landing after a stall, say) is handled
    // rather than unhandled; the caller drops the settled race, so
    // nothing accumulates across chunks.
    operation.then(resolve, reject);
  });

  try {
    armStallTimer();
    const response = await raceStall(fetchImpl(model.url, { signal: controller.signal }));
    if (!response.ok || !response.body) {
      throw Object.assign(new Error(`Model download failed (${response.status})`), { status: 502 });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.part`;
    const out = createWriteStreamImpl(partial);
    const digest = createHash('sha256');
    let received = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await raceStall(reader.read());
        if (done) break;
        armStallTimer();
        received += chunk.length;
        // The pinned size is known before the fetch, so an over-long body is
        // refused the moment it passes that size instead of being written to
        // disk in full and only then discarded: a broken or hostile endpoint
        // could otherwise fill the cache disk without bound.
        if (received > model.bytes) {
          throw Object.assign(
            new Error(`The model download was larger than the expected ${model.bytes} bytes, so it was discarded; try again`),
            { status: 502 },
          );
        }
        digest.update(chunk);
        if (!out.write(chunk)) await raceStall(new Promise((resolve) => out.once('drain', resolve)));
        onProgress(received, model.bytes);
      }
      await raceStall(new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve()))));
    } catch (error) {
      // Leave nothing running behind the failure: abort the fetch and
      // cancel the body reader, or an abandoned transfer keeps consuming
      // the connection after an early refusal (the oversize throw above
      // is the common case). The manual reader replaced a for-await loop,
      // which cancelled the stream implicitly on throw.
      controller.abort(error);
      try { await reader.cancel(); } catch { /* the body is already closed */ }
      out.destroy();
      fs.rmSync(partial, { force: true });
      throw error;
    } finally {
      reader.releaseLock?.();
    }
    if (received !== model.bytes) {
      fs.rmSync(partial, { force: true });
      throw Object.assign(new Error('The model download was incomplete; try again'), { status: 502 });
    }
    if (digest.digest('hex') !== model.sha256) {
      fs.rmSync(partial, { force: true });
      throw Object.assign(new Error('The model download did not match its checksum, so it was discarded; try again'), { status: 502 });
    }
    fs.renameSync(partial, file);
    return modelStatus(file, model);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
};

/**
 * Answers the choice questions with the local model. `loadLlama` is injected so
 * tests can run without the native runtime; the real one loads `node-llama-cpp`.
 */
export const createLocalAnswerer = ({ file = modelPath(), loadLlama = defaultLoadLlama } = {}) => {
  let runtime;
  const ready = () => {
    runtime ??= (async () => {
      const llama = await loadLlama();
      const model = await llama.loadModel({ modelPath: file });
      const context = await model.createContext({ contextSize: 1024 });
      return { llama, context };
    })().catch((error) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  };

  return {
    /** Resolves to the answer for each question key, or throws when the model cannot run. */
    answer: async ({ prompt, schema }) => {
      const { llama, context } = await ready();
      const { LlamaChatSession } = await loadLlamaChat();
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt:
          'You classify one sentence about which AI model providers to use. Answer only with the JSON object that matches the schema.',
      });
      try {
        const grammar = await llama.createGrammarForJsonSchema(schema);
        const raw = await session.prompt(prompt, { grammar, maxTokens: 120, temperature: 0 });
        return JSON.parse(raw);
      } finally {
        session.dispose({ disposeSequence: true });
      }
    },
  };
};

const defaultLoadLlama = async () => {
  const { getLlama } = await import('node-llama-cpp');
  return getLlama();
};

const loadLlamaChat = () => import('node-llama-cpp');
