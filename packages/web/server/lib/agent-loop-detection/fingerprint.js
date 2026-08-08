import { createHash } from 'node:crypto';

/** File-mutating tools most often involved in edit loops. */
const EDIT_LOOP_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'apply_patch',
  'create',
  'file_write',
]);

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const hashText = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');

/** Collapse whitespace so trivial reformats count as near-identical. */
export const normalizeContent = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const extractFilePath = (tool, input, metadata) => {
  const source = isRecord(input) ? input : {};
  const meta = isRecord(metadata) ? metadata : {};
  const fromInput = typeof source.filePath === 'string' ? source.filePath
    : typeof source.file_path === 'string' ? source.file_path
      : typeof source.path === 'string' ? source.path
        : '';
  if (fromInput.trim()) return fromInput.trim();

  const metaFiles = Array.isArray(meta.files) ? meta.files : [];
  for (const file of metaFiles) {
    if (!isRecord(file)) continue;
    const path = typeof file.relativePath === 'string' ? file.relativePath
      : typeof file.filePath === 'string' ? file.filePath
        : '';
    if (path.trim()) return path.trim();
  }

  if (isRecord(meta.filediff) && typeof meta.filediff.file === 'string' && meta.filediff.file.trim()) {
    return meta.filediff.file.trim();
  }

  if (tool === 'apply_patch') {
    const patch = typeof source.patchText === 'string' ? source.patchText
      : typeof source.patch_text === 'string' ? source.patch_text
        : typeof source.patch === 'string' ? source.patch
          : '';
    const match = patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  return '';
};

const extractContentSignature = (tool, input) => {
  const source = isRecord(input) ? input : {};
  switch (tool) {
    case 'edit':
      return stableStringify({
        old: source.oldString ?? source.old_string ?? '',
        new: source.newString ?? source.new_string ?? '',
        replaceAll: source.replaceAll ?? source.replace_all ?? false,
      });
    case 'write':
    case 'create':
    case 'file_write':
      return String(source.content ?? '');
    case 'multiedit':
      return stableStringify(source.edits ?? []);
    case 'apply_patch':
      return String(source.patchText ?? source.patch_text ?? source.patch ?? '');
    default:
      return stableStringify(source);
  }
};

/**
 * Dice coefficient over character bigrams. Cheap and good enough for near-duplicate
 * edit payloads without pulling in a dependency.
 */
export const contentSimilarity = (left, right) => {
  const a = normalizeContent(left);
  const b = normalizeContent(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigrams = (text) => {
    const map = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const gram = text.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };

  const leftMap = bigrams(a);
  const rightMap = bigrams(b);
  let overlap = 0;
  for (const [gram, count] of leftMap) {
    const other = rightMap.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / ((a.length - 1) + (b.length - 1));
};

/**
 * Build a fingerprint for a completed tool call. Returns null when the part cannot
 * be evaluated (missing tool/input).
 */
export const buildToolFingerprint = (part) => {
  if (!part || part.type !== 'tool' || typeof part.tool !== 'string' || !part.tool) return null;
  const state = isRecord(part.state) ? part.state : null;
  if (!state || !isRecord(state.input)) return null;

  const tool = part.tool.trim();
  const path = extractFilePath(tool, state.input, state.metadata);
  const content = extractContentSignature(tool, state.input);
  const exactHash = hashText(`${tool}\0${path}\0${content}`);
  const normalizedHash = hashText(`${tool}\0${path}\0${normalizeContent(content)}`);
  const callId = typeof part.callID === 'string' && part.callID
    ? part.callID
    : (typeof part.id === 'string' ? part.id : '');

  return {
    callId,
    tool,
    path,
    content,
    exactHash,
    normalizedHash,
    isEditTool: EDIT_LOOP_TOOLS.has(tool),
  };
};

/**
 * Evaluate a rolling window of fingerprints for identical / near-identical streaks.
 * Streaks are trailing (most recent consecutive matches).
 */
export const detectLoopFromWindow = (window, {
  identicalThreshold = 3,
  nearThreshold = 3,
  nearSimilarity = 0.92,
} = {}) => {
  if (!Array.isArray(window) || window.length === 0) return null;

  let identicalStreak = 1;
  for (let i = window.length - 1; i > 0; i -= 1) {
    if (window[i].exactHash !== window[i - 1].exactHash) break;
    identicalStreak += 1;
  }
  if (identicalStreak >= identicalThreshold) {
    const latest = window[window.length - 1];
    return {
      kind: 'identical',
      count: identicalStreak,
      tool: latest.tool,
      path: latest.path,
      exactHash: latest.exactHash,
    };
  }

  const latest = window[window.length - 1];
  if (!latest.isEditTool || !latest.path) return null;

  let nearStreak = 1;
  for (let i = window.length - 1; i > 0; i -= 1) {
    const current = window[i];
    const previous = window[i - 1];
    if (!previous.isEditTool) break;
    if (previous.tool !== current.tool || previous.path !== current.path) break;
    const similar = previous.normalizedHash === current.normalizedHash
      || contentSimilarity(previous.content, current.content) >= nearSimilarity;
    if (!similar) break;
    nearStreak += 1;
  }

  if (nearStreak >= nearThreshold) {
    return {
      kind: 'near-identical',
      count: nearStreak,
      tool: latest.tool,
      path: latest.path,
      exactHash: latest.exactHash,
    };
  }

  return null;
};
