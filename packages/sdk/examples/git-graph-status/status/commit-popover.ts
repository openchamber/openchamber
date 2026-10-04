import type { HostClient, HostReadyContext } from '@openchamber/sdk';
import { HostRequestError } from '@openchamber/sdk';
import { mountButton } from '@openchamber/sdk/ui';
import { z } from 'zod';

import { element, refBadge } from './view.ts';

const refKindSchema = z.enum(['local', 'remote', 'tag']);
const detailSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{7,64}$/i), parents: z.array(z.string()), author: z.string(), email: z.string(), when: z.string(), date: z.string(),
  subject: z.string(), body: z.string(), files: z.number().finite().int().nonnegative(), insertions: z.number().finite().int().nonnegative(), deletions: z.number().finite().int().nonnegative(),
});
const failureSchema = z.object({ error: z.string() });

export const commitPopoverDataSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{7,64}$/i),
  refs: z.array(z.object({ name: z.string().min(1).max(200), kind: refKindSchema, head: z.boolean() })).max(20),
  github: z.string().url().startsWith('https://github.com/').max(2_000).nullable(),
}).strict();

type CommitPopoverData = z.infer<typeof commitPopoverDataSchema>;
type Detail = z.infer<typeof detailSchema>;
const absoluteDate = (iso: string, locale: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
};

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.length === 0 ? '?' : parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
};

const askDetail = async (host: HostClient, directory: string, sha: string): Promise<Detail> => {
  let result;
  try {
    result = await host.serviceRequest({ method: 'GET', path: '/commit', query: { directory, sha } });
  } catch (error) {
    throw new Error(error instanceof HostRequestError && error.code === 'NO_SERVICE'
      ? 'Allow the local service for this extension in Settings → Extensions.'
      : 'Could not reach the local git service.');
  }
  if (result.status < 200 || result.status >= 300) throw new Error('Could not read this commit.');
  let body: unknown;
  try { body = JSON.parse(result.body); } catch { throw new Error('The git service answered with something unexpected.'); }
  const failure = failureSchema.safeParse(body);
  if (failure.success) throw new Error(failure.data.error === 'unknown-commit' ? 'That commit is no longer in this repository.' : 'Could not read this commit.');
  const parsed = detailSchema.safeParse(body);
  if (!parsed.success || !parsed.data.hash.toLowerCase().startsWith(sha.toLowerCase())) {
    throw new Error('The git service answered with something unexpected.');
  }
  return parsed.data;
};

const renderDetail = (root: HTMLElement, host: HostClient, data: CommitPopoverData, detail: Detail, locale: string): void => {
  const card = element('article', 'popover-card');
  card.dataset.commitPopover = detail.hash;
  const author = element('div', 'popover-author');
  author.append(element('span', 'popover-initials', initials(detail.author)), element('span', 'popover-author-name', detail.author));
  const metadata = element('span', 'popover-meta', `${detail.when} · ${absoluteDate(detail.date, locale)}`);
  author.append(metadata);
  card.append(author, element('div', 'popover-subject', detail.subject));
  if (detail.body) card.append(element('div', 'popover-body', detail.body));
  const stats = element('div', 'popover-stats');
  stats.append(element('span', '', `${detail.files} ${detail.files === 1 ? 'file' : 'files'} changed`));
  if (detail.insertions > 0) stats.append(element('span', 'add', `+${detail.insertions}`));
  if (detail.deletions > 0) stats.append(element('span', 'del', `−${detail.deletions}`));
  card.append(stats);
  if (data.refs.length) {
    const refs = element('div', 'popover-refs');
    refs.dataset.commitPopoverRefs = detail.hash;
    for (const ref of data.refs) refs.append(refBadge(ref.name, ref.kind, ref.head));
    card.append(refs);
  }
  const actions = element('div', 'popover-actions');
  actions.append(element('code', '', detail.hash.slice(0, 10)));
  const feedback = element('span', 'popover-feedback');
  const copy = mountButton(actions, { label: 'Copy hash', variant: 'ghost', size: 'xs', onClick: () => {
    feedback.textContent = '';
    void host.writeClipboard(detail.hash).then(() => {
      copy.update({ label: 'Copied' });
      setTimeout(() => copy.update({ label: 'Copy hash' }), 1_500);
    }).catch(() => { feedback.textContent = 'Copy failed.'; });
  } });
  mountButton(actions, { label: 'Open diff', variant: 'secondary', size: 'xs', onClick: () => {
    feedback.textContent = '';
    void host.openCommit(detail.hash).catch(() => { feedback.textContent = 'Could not open the diff.'; });
  } });
  const github = data.github;
  if (github) {
    mountButton(actions, { label: 'Open on GitHub', variant: 'secondary', size: 'xs', onClick: () => {
      feedback.textContent = '';
      void host.openUrl(`${github.replace(/\/$/, '')}/commit/${detail.hash}`).catch(() => { feedback.textContent = 'Could not open the link.'; });
    } });
  }
  card.append(actions, feedback);
  root.replaceChildren(card);
};

/** Renders the popover child without mounting the status graph or its preferences. */
export const startCommitPopover = (root: HTMLElement, host: HostClient, context: HostReadyContext): void => {
  let reportedHeight = -1;
  const observer = new ResizeObserver(() => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === reportedHeight) return;
    reportedHeight = height;
    void host.setHeight(height).catch(() => undefined);
  });
  observer.observe(root);
  root.ownerDocument.defaultView?.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  const data = commitPopoverDataSchema.safeParse(context.popover?.data);
  if (context.surface !== 'popover' || !context.popover || !data.success || !context.directory) {
    root.replaceChildren(element('div', 'error', 'This commit preview is unavailable.'));
    return;
  }
  root.replaceChildren(element('div', 'note', 'Loading commit…'));
  const directory = context.directory;
  let active = true;
  let stopDirectory = (): void => undefined;
  const window = root.ownerDocument.defaultView;
  const retire = (): void => {
    active = false;
    observer.disconnect();
    stopDirectory();
    window?.removeEventListener('pagehide', retire);
  };
  stopDirectory = host.onDirectory((next) => { if (next !== directory) retire(); });
  window?.addEventListener('pagehide', retire, { once: true });
  const finish = (): void => {
    stopDirectory();
    window?.removeEventListener('pagehide', retire);
  };
  void askDetail(host, directory, data.data.sha).then((detail) => {
    if (!active) return;
    finish();
    renderDetail(root, host, data.data, detail, context.locale);
  }).catch((error) => {
    if (!active) return;
    finish();
    root.replaceChildren(element('div', 'error', error instanceof Error ? error.message : 'Could not read this commit.'));
  });
};
