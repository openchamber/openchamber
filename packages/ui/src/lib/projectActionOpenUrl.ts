
import type { GitAPI } from '@/lib/api/types';

type OpenUrlGit = Pick<GitAPI, 'getGitStatus' | 'isLinkedWorktree'>;

const TEMPLATE_VARIABLE_PATTERN = /\{(worktree|branch)\}/g;
const MAX_DNS_LABEL_LENGTH = 63;
const DEFAULT_BRANCHES = new Set(['main', 'master']);

export const hasOpenUrlTemplate = (value: string | undefined): boolean => (
  /\{(worktree|branch)\}/.test(value ?? '')
);

const shortHash = async (value: string): Promise<string | null> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 3), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const toHostnameLabel = async (name: string): Promise<string> => {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (label.length <= MAX_DNS_LABEL_LENGTH) return label;
  const hash = await shortHash(label);
  if (!hash) return label.slice(0, MAX_DNS_LABEL_LENGTH).replace(/-+$/, '');
  return `${label.slice(0, MAX_DNS_LABEL_LENGTH - 7).replace(/-+$/, '')}-${hash}`;
};

type OpenUrlCheckout = {
  readonly branch: string | null;
  readonly linkedWorktree: boolean;
};

const normalizeBranch = (branch: string | null | undefined): string | null => {
  const trimmed = branch?.trim() ?? '';
  return trimmed && trimmed !== 'HEAD' ? trimmed : null;
};

const readOpenUrlCheckout = async (git: OpenUrlGit, directory: string, template: string): Promise<OpenUrlCheckout> => {
  const needsBranch = template.includes('{branch}');
  const linkedWorktree = template.includes('{worktree}') ? await git.isLinkedWorktree(directory) : false;
  if (!needsBranch && !linkedWorktree) return { branch: null, linkedWorktree };
  const status = await git.getGitStatus(directory, { mode: 'light' });
  return { branch: normalizeBranch(status.current), linkedWorktree };
};

const worktreeLabel = async (checkout: OpenUrlCheckout): Promise<string> => {
  if (!checkout.linkedWorktree || !checkout.branch || DEFAULT_BRANCHES.has(checkout.branch)) return '';
  return toHostnameLabel(checkout.branch.split('/').pop() ?? '');
};

const tidyHost = (authority: string): string => {
  const at = authority.lastIndexOf('@');
  const userInfo = at >= 0 ? authority.slice(0, at + 1) : '';
  const hostPort = authority.slice(at + 1);
  if (hostPort.startsWith('[')) return authority;
  const colon = hostPort.lastIndexOf(':');
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon >= 0 ? hostPort.slice(colon) : '';
  const labels = host.split('.').map((label) => label.replace(/^-+|-+$/g, '')).filter(Boolean);
  return `${userInfo}${labels.join('.')}${port}`;
};

export const fillOpenUrlTemplate = async (template: string, checkout: OpenUrlCheckout): Promise<string> => {
  const values = {
    worktree: await worktreeLabel(checkout),
    branch: checkout.branch ? await toHostnameLabel(checkout.branch) : '',
  };
  const filled = template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, name: 'worktree' | 'branch') => values[name]);
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(filled);
  if (!parts) return filled;
  const [, scheme = '', authority = '', rest = ''] = parts;
  return `${scheme}${tidyHost(authority)}${rest}`;
};

export const resolveOpenUrl = async (git: OpenUrlGit, template: string, directory: string): Promise<string> => {
  if (!hasOpenUrlTemplate(template)) return template;
  return fillOpenUrlTemplate(template, await readOpenUrlCheckout(git, directory, template));
};
