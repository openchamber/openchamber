// What the server can follow on a client's behalf: a GitHub pull request or
// issue, a GitLab merge request or issue, or a Linear issue. Parsed here once,
// at the boundary; everything past this file works with these shapes and the
// key they produce.

const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
const text = (value) => (isText(value) ? value.trim() : '');
export const isPlainRecord = (value) => Object.prototype.toString.call(value) === '[object Object]';

const KINDS = new Set(['pull', 'issue']);
const LINEAR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SEGMENT = /^[^\s/]+$/;
const NAMESPACE = /^[^\s/]+(?:\/[^\s/]+)*$/;

const positiveNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

const instanceOrigin = (value) => {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin.toLowerCase() : '';
  } catch {
    return '';
  }
};

/**
 * One followed item, or null when the value names nothing the server can
 * read. GitLab owners are namespace paths and may contain subgroups; GitHub
 * owners and every repository name are single segments. `accountId` names the
 * account a repository is bound to (a branch's pull request); without it the
 * host's current account reads it (a linked item).
 */
export function parseTrackedItem(value) {
  if (!isPlainRecord(value)) return null;
  const provider = text(value.provider);
  if (provider === 'linear') {
    const identifier = text(value.identifier).toUpperCase();
    return LINEAR_IDENTIFIER.test(identifier) ? { provider, identifier } : null;
  }
  const kind = text(value.kind);
  const owner = text(value.owner);
  const repo = text(value.repo);
  const number = positiveNumber(value.number);
  if (!KINDS.has(kind) || !SEGMENT.test(repo) || number === null) return null;
  const accountId = text(value.accountId);
  const account = accountId ? { accountId } : {};
  if (provider === 'github') {
    return SEGMENT.test(owner) ? { provider, kind, owner, repo, number, ...account } : null;
  }
  if (provider === 'gitlab') {
    const instance = instanceOrigin(value.instance);
    return instance && NAMESPACE.test(owner) ? { provider, instance, kind, owner, repo, number, ...account } : null;
  }
  return null;
}

/** Case-insensitive identity, the same one the UI computes for the same item. */
export function trackedItemKey(item) {
  if (item.provider === 'linear') return `linear|${item.identifier.toUpperCase()}`;
  const thread = `${item.kind}|${item.owner}/${item.repo}#${item.number}`.toLowerCase();
  // Account ids are opaque and case-sensitive; they stay as they are.
  const account = item.accountId ? `@${item.accountId}` : '';
  return item.provider === 'gitlab' ? `gitlab|${item.instance}|${thread}${account}` : `github|${thread}${account}`;
}

/** Reads a list of items, dropping malformed ones and duplicates; null when the value is not a list. */
export function parseTrackedItems(value, limit) {
  if (!Array.isArray(value) || value.length > limit) return null;
  const items = new Map();
  for (const raw of value) {
    const item = parseTrackedItem(raw);
    if (item) items.set(trackedItemKey(item), item);
  }
  return items;
}
