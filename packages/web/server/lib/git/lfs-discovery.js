import { normalizeDiscoveryEndpoint, resolveGitRelativeEndpoint } from './discovery-endpoint.js';

export const LFS_DISCOVERY_LIMITS = Object.freeze({
  maxFilesBytes: 16 * 1024 * 1024,
  maxBatchBytes: 256 * 1024,
  fileBatchSize: 128,
  maxAttributesBytes: 256 * 1024,
  maxConfigBytes: 256 * 1024,
  maxAttributeRecords: 1_024,
  maxPointerSamples: 256,
  maxPointerBytes: 1_024,
  maxPublicRecords: 256,
  maxRemoteUrls: 256,
});

const CONTROL_PATTERN = /[\0-\x1f\x7f]/;
const OID_PATTERN = /^sha256:([0-9a-f]{64})$/;
const SIZE_PATTERN = /^(0|[1-9][0-9]*)$/;
const SAFE_FILTERS = Object.freeze({
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
});
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

const lfsError = (message, code = 'INVALID_LFS_DISCOVERY_INPUT') => Object.assign(new Error(message), { code });

const boundedText = (value, maxBytes, label) => {
  if (!(isString(value) || Buffer.isBuffer(value))) throw lfsError(`${label} is invalid`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.byteLength > maxBytes) throw lfsError(`${label} exceeds its byte limit`, 'LFS_DISCOVERY_LIMIT_EXCEEDED');
  const text = bytes.toString('utf8');
  if (text.includes('\ufffd')) throw lfsError(`${label} is not valid UTF-8`);
  return text;
};

const parseConfig = (value, limits, label) => {
  const text = boundedText(value, limits.maxConfigBytes, label);
  if (!text) return new Map();
  if (!text.endsWith('\0')) throw lfsError(`${label} is incomplete`);
  const result = new Map();
  for (const record of text.slice(0, -1).split('\0')) {
    const separator = record.indexOf('\n');
    if (separator <= 0 || separator === record.length - 1) throw lfsError(`${label} record is malformed`);
    const key = record.slice(0, separator).toLowerCase();
    const configValue = record.slice(separator + 1);
    if (result.has(key)) throw lfsError(`${label} contains duplicate ${key}`);
    result.set(key, configValue);
  }
  return result;
};

const validateRepositoryPath = (value) => {
  if (!value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\') || CONTROL_PATTERN.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw lfsError('LFS discovery path is unsafe');
  }
  return value;
};

const parseAttributes = (value, limits) => {
  const text = boundedText(value, limits.maxAttributesBytes, 'Effective attributes output');
  if (!text) return [];
  if (!text.endsWith('\0')) throw lfsError('Effective attributes output is incomplete');
  const fields = text.slice(0, -1).split('\0');
  if (fields.length % 3 !== 0 || fields.length / 3 > limits.maxAttributeRecords) {
    throw lfsError('Effective attributes output is malformed', fields.length / 3 > limits.maxAttributeRecords
      ? 'LFS_DISCOVERY_LIMIT_EXCEEDED' : 'INVALID_LFS_DISCOVERY_INPUT');
  }
  const paths = [];
  const seen = new Set();
  for (let index = 0; index < fields.length; index += 3) {
    const filePath = validateRepositoryPath(fields[index]);
    if (fields[index + 1] !== 'filter' || !fields[index + 2]) throw lfsError('Effective attributes output is malformed');
    if (fields[index + 2] === 'lfs' && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
      if (paths.length > limits.maxPublicRecords) {
        throw lfsError('LFS attribute records exceed their public record limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
      }
    }
  }
  return paths;
};

export async function scanLfsFiles(filesOutput, query, gitlinkPaths = []) {
  const limits = LFS_DISCOVERY_LIMITS;
  const text = boundedText(filesOutput, limits.maxFilesBytes, 'Tracked files output');
  if (text && !text.endsWith('\0')) throw lfsError('Tracked files output is incomplete');
  const gitlinks = new Set(gitlinkPaths);
  const attributes = [];
  let attributesBytes = 0;
  const pointerSamples = [];
  const prefix = Buffer.from('version https://git-lfs.github.com/spec/');
  for (let offset = 0; offset < text.length;) {
    const batch = [];
    let batchBytes = 0;
    while (offset < text.length && batch.length < limits.fileBatchSize) {
      const end = text.indexOf('\0', offset);
      const file = validateRepositoryPath(text.slice(offset, end));
      const bytes = Buffer.byteLength(file) + 32;
      if (bytes > limits.maxBatchBytes) throw lfsError('Tracked path exceeds its byte limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
      if (batchBytes + bytes > limits.maxBatchBytes) break;
      offset = end + 1;
      if (gitlinks.has(file)) continue;
      batch.push(file);
      batchBytes += bytes;
    }
    if (!batch.length) continue;
    const output = await query(['check-attr', '--stdin', '-z', 'filter'], Buffer.from(`${batch.join('\0')}\0`));
    const selected = parseAttributes(output, limits);
    const fields = output.toString('utf8').split('\0');
    if (fields.length !== batch.length * 3 + 1 || batch.some((file, index) => fields[index * 3] !== file)) {
      throw lfsError('Effective attributes output does not cover the requested files');
    }
    for (const file of selected) {
      const record = `${file}\0filter\0lfs\0`;
      attributesBytes += Buffer.byteLength(record);
      if (attributesBytes > limits.maxAttributesBytes) {
        throw lfsError('LFS attribute records exceed their byte limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
      }
      attributes.push(record);
    }
    if (attributes.length > limits.maxPublicRecords) {
      throw lfsError('LFS attribute records exceed their public record limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
    }

    // Query sizes without reading blobs. Only pointer-sized blobs enter the
    // bounded content query; Git LFS pointers fit within 1 KiB.
    const metadata = boundedText(await query(['cat-file', '--batch-check'],
      Buffer.from(`${batch.map((file) => `HEAD:${file}`).join('\n')}\n`)), limits.maxBatchBytes, 'Git object metadata');
    const records = metadata.split('\n');
    if (records.pop() !== '' || records.length !== batch.length) throw lfsError('Git object metadata is incomplete');
    const candidates = [];
    for (let index = 0; index < records.length; index += 1) {
      const match = records[index].match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|commit) (0|[1-9][0-9]*)$/);
      if (!match || !Number.isSafeInteger(Number(match[3]))) throw lfsError('Git object metadata is invalid');
      if (match[2] === 'blob' && Number(match[3]) <= limits.maxPointerBytes) {
        candidates.push({ path: batch[index], oid: match[1], size: Number(match[3]) });
      }
    }
    // Attributes are evidence, not an exhaustive list of pointer paths.
    const selectedPaths = new Set(selected);
    candidates.sort((left, right) => Number(selectedPaths.has(right.path)) - Number(selectedPaths.has(left.path)));
    if (!candidates.length) continue;
    const contents = await query(['cat-file', '--batch'], Buffer.from(`${candidates.map((file) => file.oid).join('\n')}\n`));
    if (!Buffer.isBuffer(contents) || contents.length > limits.maxBatchBytes) throw lfsError('Git object batch is invalid');
    let position = 0;
    for (const candidate of candidates) {
      const header = Buffer.from(`${candidate.oid} blob ${candidate.size}\n`);
      if (!contents.subarray(position, position + header.length).equals(header)) throw lfsError('Git object batch header is invalid');
      position += header.length;
      const content = contents.subarray(position, position + candidate.size);
      position += candidate.size;
      if (content.length !== candidate.size || contents[position++] !== 10) throw lfsError('Git object batch is incomplete');
      if (content.subarray(0, prefix.length).equals(prefix)) {
        parseLfsPointer(content);
        pointerSamples.push({ path: candidate.path, content: Buffer.from(content) });
        if (pointerSamples.length > limits.maxPointerSamples) {
          throw lfsError('LFS pointers exceed their record limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
        }
      }
    }
    if (position !== contents.length) throw lfsError('Git object batch contains unexpected output');
  }
  return { attributesOutput: attributes.join(''), pointerSamples, pointerScanComplete: true };
}

export function parseLfsPointer(content, { maxBytes = LFS_DISCOVERY_LIMITS.maxPointerBytes } = {}) {
  const text = boundedText(content, maxBytes, 'LFS pointer sample');
  if (text.startsWith('version https://git-lfs.github.com/spec/v1') && text.includes('\r')) {
    throw lfsError('LFS pointer is malformed');
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = normalized.split('\n');
  if (lines[0] !== 'version https://git-lfs.github.com/spec/v1') {
    if (lines[0].startsWith('version https://git-lfs.github.com/spec/')) {
      throw lfsError('LFS pointer is malformed');
    }
    return null;
  }
  if (lines.length < 3 || lines.some((line) => line.endsWith('\r'))) throw lfsError('LFS pointer is malformed');
  const oidLines = lines.filter((line) => line.startsWith('oid '));
  const sizeLines = lines.filter((line) => line.startsWith('size '));
  const extensionLines = lines.slice(1, -2);
  if (oidLines.length !== 1 || sizeLines.length !== 1
    || lines.at(-2) !== oidLines[0] || lines.at(-1) !== sizeLines[0]
    || extensionLines.some((line) => !/^ext-[A-Za-z0-9][A-Za-z0-9.-]* [A-Za-z0-9+/=._:-]+$/.test(line))) {
    throw lfsError('LFS pointer is malformed');
  }
  const oid = oidLines[0].slice(4).match(OID_PATTERN);
  const size = sizeLines[0].slice(5);
  if (!oid || !SIZE_PATTERN.test(size)) throw lfsError('LFS pointer is malformed');
  const numericSize = Number(size);
  if (!Number.isSafeInteger(numericSize)) throw lfsError('LFS pointer size is outside the supported range');
  return Object.freeze({ oid: oid[1], size: numericSize });
}

export async function scanLfsPushObjects(objectIdsOutput, query) {
  const limits = LFS_DISCOVERY_LIMITS;
  const text = boundedText(objectIdsOutput, limits.maxFilesBytes, 'Push object listing');
  if (text && !text.endsWith('\n')) throw lfsError('Push object listing is incomplete');
  const pointers = new Map();
  const prefix = Buffer.from('version https://git-lfs.github.com/spec/');
  for (let offset = 0; offset < text.length;) {
    const batch = [];
    while (offset < text.length && batch.length < limits.fileBatchSize) {
      const end = text.indexOf('\n', offset);
      const oid = text.slice(offset, end);
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) throw lfsError('Push object ID is invalid');
      batch.push(oid);
      offset = end + 1;
    }
    const metadata = boundedText(await query(['cat-file', '--batch-check'], Buffer.from(`${batch.join('\n')}\n`)),
      limits.maxBatchBytes, 'Push object metadata').split('\n');
    if (metadata.pop() !== '' || metadata.length !== batch.length) throw lfsError('Push object metadata is incomplete');
    const candidates = [];
    for (let index = 0; index < batch.length; index += 1) {
      const match = metadata[index].match(/^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|tree|commit|tag) (0|[1-9][0-9]*)$/);
      if (!match || match[1] !== batch[index] || !Number.isSafeInteger(Number(match[3]))) throw lfsError('Push object metadata is invalid');
      if (match[2] === 'blob' && Number(match[3]) <= limits.maxPointerBytes) {
        candidates.push({ oid: match[1], size: Number(match[3]) });
      }
    }
    if (!candidates.length) continue;
    const contents = await query(['cat-file', '--batch'], Buffer.from(`${candidates.map((file) => file.oid).join('\n')}\n`));
    if (!Buffer.isBuffer(contents) || contents.length > limits.maxBatchBytes) throw lfsError('Push object batch is invalid');
    let position = 0;
    for (const candidate of candidates) {
      const header = Buffer.from(`${candidate.oid} blob ${candidate.size}\n`);
      if (!contents.subarray(position, position + header.length).equals(header)) throw lfsError('Push object batch header is invalid');
      position += header.length;
      const content = contents.subarray(position, position + candidate.size);
      position += candidate.size;
      if (content.length !== candidate.size || contents[position++] !== 10) throw lfsError('Push object batch is incomplete');
      if (!content.subarray(0, prefix.length).equals(prefix)) continue;
      const pointer = parseLfsPointer(content);
      if (pointers.has(pointer.oid) && pointers.get(pointer.oid).size !== pointer.size) throw lfsError('LFS pointer sizes disagree');
      pointers.set(pointer.oid, pointer);
      if (pointers.size > limits.maxPublicRecords) throw lfsError('Push LFS object limit exceeded', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
    }
    if (position !== contents.length) throw lfsError('Push object batch contains unexpected output');
  }
  return [...pointers.values()];
}

const validateExecutableConfig = (config) => {
  for (const [key, value] of config) {
    if (key.startsWith('lfs.customtransfer.') || key === 'lfs.standalonetransferagent') {
      throw lfsError('Custom LFS transfer configuration is unsafe', 'UNSAFE_LFS_EXECUTABLE_CONFIG');
    }
    if (key in SAFE_FILTERS && value !== SAFE_FILTERS[key]) {
      throw lfsError('Custom LFS filter configuration is unsafe', 'UNSAFE_LFS_EXECUTABLE_CONFIG');
    }
  }
};

const httpsCandidate = (value, gitRemoteUrl) => {
  let candidate;
  try {
    candidate = resolveGitRelativeEndpoint(value, gitRemoteUrl);
  } catch {
    throw lfsError('LFS endpoint is malformed');
  }
  if (candidate.kind !== 'https') throw lfsError('LFS endpoint must use HTTPS');
  return candidate;
};

export function resolveLfsPushConfig({ lfsConfigOutput, effectiveConfigOutput, gitRemoteName, gitRemoteUrl }) {
  const committed = parseConfig(lfsConfigOutput, LFS_DISCOVERY_LIMITS, 'Committed LFS configuration');
  const effective = parseConfig(effectiveConfigOutput, LFS_DISCOVERY_LIMITS, 'Effective LFS configuration');
  validateExecutableConfig(effective);
  const remoteUrlKey = `remote.${gitRemoteName.toLowerCase()}.lfsurl`;
  for (const key of committed.keys()) {
    if (!['lfs.url', 'lfs.pushurl', 'lfs.allowincompletepush', remoteUrlKey].includes(key)) {
      throw lfsError('Unsupported committed LFS publication configuration');
    }
  }
  const value = (key) => effective.get(key) ?? committed.get(key);
  const configured = value('lfs.pushurl') || value('lfs.url')
    || effective.get(`remote.${gitRemoteName.toLowerCase()}.lfspushurl`) || value(remoteUrlKey);
  const remote = normalizeDiscoveryEndpoint(gitRemoteUrl);
  const base = remote.endpoint.replace(/\/$/, '');
  const endpoint = configured ? httpsCandidate(configured, gitRemoteUrl)
    : remote.kind === 'https' ? httpsCandidate(`${base}${base.endsWith('.git') ? '' : '.git'}/info/lfs`, gitRemoteUrl) : null;
  const storagePath = effective.get('lfs.storage') ?? null;
  if (storagePath !== null && (!storagePath || CONTROL_PATTERN.test(storagePath))) throw lfsError('LFS storage path is invalid');
  return { endpoint, storagePath };
}

export function discoverLfs({
  attributesOutput,
  pointerSamples,
  lfsConfigOutput = '',
  effectiveConfigOutput = '',
  gitRemoteName,
  gitRemoteUrl,
  remoteLfsUrls = [],
  lfsBinaryAvailable,
  pointerScanComplete = true,
}, limitOverrides = {}) {
  const limits = { ...LFS_DISCOVERY_LIMITS, ...limitOverrides };
  if (!isString(gitRemoteName) || !gitRemoteName || CONTROL_PATTERN.test(gitRemoteName)
    || !isString(gitRemoteUrl) || (lfsBinaryAvailable !== true && lfsBinaryAvailable !== false)
    || (pointerScanComplete !== true && pointerScanComplete !== false)
    || !Array.isArray(pointerSamples) || !Array.isArray(remoteLfsUrls)) {
    throw lfsError('LFS discovery input is invalid');
  }
  const gitRemote = normalizeDiscoveryEndpoint(gitRemoteUrl);
  const attributePaths = parseAttributes(attributesOutput, limits);
  if (pointerSamples.length > limits.maxPointerSamples || remoteLfsUrls.length > limits.maxRemoteUrls) {
    throw lfsError('LFS discovery input exceeds its record limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
  }
  const pointers = [];
  const seenPointerPaths = new Set();
  for (const sample of pointerSamples) {
    if (!sample || Object.getPrototypeOf(sample) !== Object.prototype
      || Object.keys(sample).length !== 2 || !Object.hasOwn(sample, 'path') || !Object.hasOwn(sample, 'content')) {
      throw lfsError('LFS pointer sample is invalid');
    }
    const samplePath = validateRepositoryPath(sample.path);
    if (seenPointerPaths.has(samplePath)) throw lfsError(`LFS pointer sample ${samplePath} is duplicated`);
    seenPointerPaths.add(samplePath);
    const pointer = parseLfsPointer(sample.content, { maxBytes: limits.maxPointerBytes });
    if (pointer) {
      pointers.push(Object.freeze({ path: samplePath, ...pointer }));
      if (pointers.length > limits.maxPublicRecords) {
        throw lfsError('LFS pointers exceed their public record limit', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
      }
    }
  }

  const lfsConfig = parseConfig(lfsConfigOutput, limits, '.lfsconfig output');
  const effectiveConfig = parseConfig(effectiveConfigOutput, limits, 'Effective LFS config output');
  validateExecutableConfig(effectiveConfig);
  for (const key of lfsConfig.keys()) {
    if (key !== 'lfs.url' && key !== `remote.${gitRemoteName.toLowerCase()}.lfsurl`) {
      throw lfsError(`Unsupported .lfsconfig key ${key}`);
    }
  }
  const remoteUrls = new Map();
  for (const record of remoteLfsUrls) {
    if (!record || Object.getPrototypeOf(record) !== Object.prototype
      || Object.keys(record).length !== 2 || !isString(record.remote) || !isString(record.url)
      || !record.remote || CONTROL_PATTERN.test(record.remote) || remoteUrls.has(record.remote)) {
      throw lfsError('Remote-specific LFS URL input is invalid');
    }
    remoteUrls.set(record.remote, record.url);
    httpsCandidate(record.url, gitRemoteUrl);
  }

  const configuredUrl = lfsConfig.get('lfs.url');
  const scopedUrl = lfsConfig.get(`remote.${gitRemoteName.toLowerCase()}.lfsurl`) || remoteUrls.get(gitRemoteName);
  let endpoint;
  if (configuredUrl || scopedUrl) {
    endpoint = Object.freeze({
      status: 'resolved',
      source: configuredUrl ? 'lfsconfig' : 'remote',
      candidate: httpsCandidate(configuredUrl || scopedUrl, gitRemoteUrl),
    });
  } else if (gitRemote.kind === 'https') {
    endpoint = Object.freeze({
      status: 'resolved',
      source: 'git-remote',
      candidate: httpsCandidate(`${gitRemote.endpoint}/info/lfs`, gitRemoteUrl),
    });
  } else {
    endpoint = Object.freeze({ status: 'unresolved', reason: 'ssh-git-remote' });
  }

  const needed = attributePaths.length > 0 || pointers.length > 0 || lfsConfig.size > 0;
  if (!needed && !pointerScanComplete) {
    throw lfsError('LFS pointer scan did not cover every tracked file', 'LFS_DISCOVERY_LIMIT_EXCEEDED');
  }
  let client;
  if (!needed) {
    client = Object.freeze({ status: 'not-required' });
  } else if (lfsBinaryAvailable) {
    client = Object.freeze({ status: 'available' });
  } else {
    client = Object.freeze({
      status: 'missing',
      code: 'GIT_LFS_CLIENT_MISSING',
      action: 'install-git-lfs',
    });
  }
  return Object.freeze({
    needed,
    attributePaths: Object.freeze(attributePaths),
    pointers: Object.freeze(pointers),
    endpoint,
    client,
  });
}
