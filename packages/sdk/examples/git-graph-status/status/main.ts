import { connectHost, HostRequestError, type SessionLifecyclePhase } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountCheckbox, mountTabs } from '@openchamber/sdk/ui';
import { z } from 'zod';

import { layoutGraph } from './graph.ts';
import { STYLE, drawRail, drawRowGraph, element, graphWidth, refBadge, type RefKind } from './view.ts';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');
const style = document.createElement('style');
style.textContent = STYLE;
document.head.append(style);

// ----- Service answers, parsed at the boundary -----

const refKindSchema = z.enum(['local', 'remote', 'tag']);
const logSchema = z.object({
  commits: z.array(z.object({
    hash: z.string(), parents: z.array(z.string()), author: z.string(), when: z.string(), date: z.string(), subject: z.string(),
    refs: z.array(z.object({ name: z.string(), kind: refKindSchema, head: z.boolean() })),
  })),
  uncommitted: z.number().int().min(0),
});
const refsSchema = z.object({
  branch: z.string().nullable(), upstream: z.string().nullable(), github: z.string().nullable(),
  refs: z.array(z.object({ name: z.string(), kind: refKindSchema })),
});
const detailSchema = z.object({
  hash: z.string(), parents: z.array(z.string()), author: z.string(), email: z.string(), when: z.string(), date: z.string(),
  subject: z.string(), body: z.string(), files: z.number(), insertions: z.number(), deletions: z.number(),
});
const failureSchema = z.object({ error: z.string() });
const modeSchema = z.enum(['auto', 'all', 'manual']);
const prefsSchema = z.object({ mode: modeSchema, picked: z.array(z.string()).max(50) });

type Commit = z.infer<typeof logSchema>['commits'][number];
type Refs = z.infer<typeof refsSchema>;
type Detail = z.infer<typeof detailSchema>;
type Mode = z.infer<typeof modeSchema>;
type DetailState = { status: 'loading' } | { status: 'ready'; detail: Detail } | { status: 'error'; message: string };

class ServiceFailure extends Error {}

const describeFailure = (code: string): string => {
  if (code === 'not-a-repo') return 'This project is not a git repository.';
  if (code === 'no-git') return 'git is not installed on the OpenChamber host.';
  if (code === 'unknown-commit') return 'That commit is no longer in this repository.';
  return 'Could not read the git history.';
};

const ask = async <T>(path: string, query: Record<string, string>, schema: z.ZodType<T>): Promise<T> => {
  let result;
  try {
    result = await host.serviceRequest({ method: 'GET', path, query });
  } catch (error) {
    throw new ServiceFailure(error instanceof HostRequestError && error.code === 'NO_SERVICE'
      ? 'Allow the local service for this extension in Settings → Extensions.'
      : 'Could not reach the local git service.');
  }
  let body: unknown;
  try { body = JSON.parse(result.body); } catch { throw new ServiceFailure('The git service answered with something unexpected.'); }
  const failure = failureSchema.safeParse(body);
  if (failure.success) throw new ServiceFailure(describeFailure(failure.data.error));
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ServiceFailure('The git service answered with something unexpected.');
  return parsed.data;
};

// ----- State -----

let directory: string | null = null;
let locale = 'en';
let mode: Mode = 'auto';
let picked = new Set<string>();
let refs: Refs | null = null;
let commits: Commit[] = [];
let uncommitted = 0;
let note: string | null = 'Loading commits…';
let openHash: string | null = null;
const details = new Map<string, DetailState>();
let generation = 0;

const refKey = (ref: { name: string; kind: RefKind }) => `${ref.kind}:${ref.name}`;

// Storage keys are capped at 128 characters, so a project is named by a hash of its path.
const prefsKey = (dir: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < dir.length; index++) hash = Math.imul(hash ^ dir.charCodeAt(index), 16777619);
  return `prefs:${(hash >>> 0).toString(36)}`;
};

const savePrefs = () => {
  if (directory) void host.storage.set(prefsKey(directory), { mode, picked: [...picked].slice(0, 50) }).catch(() => undefined);
};

const loadPrefs = async (dir: string) => {
  const stored = prefsSchema.safeParse(await host.storage.get(prefsKey(dir)).catch(() => undefined));
  mode = stored.success ? stored.data.mode : 'auto';
  picked = new Set(stored.success ? stored.data.picked : []);
};

// ----- Loading -----

const load = async () => {
  const current = ++generation;
  if (!directory) {
    commits = []; note = 'Open a project to see its commits.'; render();
    return;
  }
  if (commits.length === 0) { note = 'Loading commits…'; render(); }
  const dir = directory;
  try {
    const [nextRefs, log] = await Promise.all([
      ask('/refs', { directory: dir }, refsSchema),
      ask('/log', { directory: dir, mode, refs: [...picked].join(','), limit: '40' }, logSchema),
    ]);
    if (current !== generation) return;
    refs = nextRefs;
    commits = log.commits;
    uncommitted = mode === 'manual' ? 0 : log.uncommitted;
    note = commits.length === 0 ? 'No commits yet.' : null;
    // A detail read before a refresh may describe a rewritten commit.
    details.clear();
    if (openHash && !commits.some((commit) => commit.hash === openHash)) openHash = null;
    if (openHash) void loadDetail(openHash);
  } catch (error) {
    if (current !== generation) return;
    commits = [];
    note = error instanceof ServiceFailure ? error.message : 'Could not read the git history.';
  }
  render();
};

const loadDetail = async (hash: string) => {
  const known = details.get(hash)?.status;
  if (!directory || known === 'ready' || known === 'loading') return;
  details.set(hash, { status: 'loading' });
  render();
  try {
    const detail = await ask('/commit', { directory, sha: hash }, detailSchema);
    details.set(hash, { status: 'ready', detail });
  } catch (error) {
    details.set(hash, { status: 'error', message: error instanceof ServiceFailure ? error.message : 'Could not read this commit.' });
  }
  render();
};

// ----- Header: mode toggles, refresh, manual ref picker -----

const bar = element('div', 'bar');
const picker = element('div', 'picker');
const list = element('div');
root.append(bar, picker, list);

const tabs = mountTabs(bar, {
  items: [{ id: 'auto', label: 'Auto' }, { id: 'all', label: 'All' }, { id: 'manual', label: 'Manual' }],
  activeId: mode,
  onChange: (id) => {
    const next = modeSchema.safeParse(id);
    if (!next.success || next.data === mode) return;
    mode = next.data;
    tabs.update({ activeId: mode });
    savePrefs();
    void load();
  },
});
bar.append(element('span', 'grow'));
const refresh = mountButton(bar, { label: 'Refresh', variant: 'ghost', size: 'xs', onClick: () => { void load(); } });

const renderPicker = () => {
  picker.replaceChildren();
  picker.hidden = mode !== 'manual';
  if (mode !== 'manual' || !refs) return;
  const choices = refs.refs.filter((ref) => ref.kind !== 'tag').slice(0, 40);
  for (const kind of ['local', 'remote'] as const) {
    const group = choices.filter((ref) => ref.kind === kind);
    if (group.length === 0) continue;
    picker.append(element('div', 'picker-group', kind === 'local' ? 'Branches' : 'Remote branches'));
    for (const ref of group) {
      mountCheckbox(picker, {
        label: ref.name,
        checked: picked.has(refKey(ref)),
        onChange: (checked) => {
          if (checked) picked.add(refKey(ref)); else picked.delete(refKey(ref));
          savePrefs();
          void load();
        },
      });
    }
  }
};

// ----- Rows -----

const absoluteDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
};

const renderDetail = (card: HTMLElement, commit: Commit) => {
  const state = details.get(commit.hash);
  if (!state || state.status === 'loading') { card.append(element('div', 'row', 'Loading details…')); return; }
  if (state.status === 'error') { card.append(element('div', 'error', state.message)); return; }
  const { detail } = state;
  card.append(element('div', 'full', detail.subject));
  if (detail.body) card.append(element('div', 'body', detail.body));
  const who = element('div', 'row', `${detail.author} <${detail.email}>`);
  const when = element('div', 'row', `${detail.when} · ${absoluteDate(detail.date)}`);
  const stats = element('div', 'row');
  stats.append(
    element('span', '', `${detail.files} ${detail.files === 1 ? 'file' : 'files'} changed`),
    element('span', 'add', `+${detail.insertions}`),
    element('span', 'del', `−${detail.deletions}`),
  );
  const hashRow = element('div', 'row');
  hashRow.append(element('code', '', detail.hash.slice(0, 10)));
  const copy = mountButton(hashRow, { label: 'Copy hash', variant: 'ghost', size: 'xs', onClick: () => {
    void host.writeClipboard(detail.hash).then(() => {
      copy.update({ label: 'Copied' });
      setTimeout(() => copy.update({ label: 'Copy hash' }), 1500);
    }).catch(() => copy.update({ label: 'Copy failed' }));
  } });
  const actions = element('div', 'actions');
  const status = element('div', 'error');
  mountButton(actions, { label: 'Open diff', variant: 'secondary', size: 'xs', onClick: () => {
    status.textContent = '';
    void (async () => {
      try {
        await host.openCommit(detail.hash);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not open the diff.';
      }
    })();
  } });
  const github = refs?.github;
  if (github) {
    mountButton(actions, { label: 'Open on GitHub', variant: 'ghost', size: 'xs', onClick: () => {
      void host.openUrl(`${github}/commit/${detail.hash}`).catch(() => { status.textContent = 'Could not open the link.'; });
    } });
  }
  card.append(who, when, stats, hashRow, actions, status);
};

const render = () => {
  refresh.update({ disabled: !directory });
  renderPicker();
  if (note) {
    list.replaceChildren(element('div', 'note', note));
    return;
  }
  // The working tree sits on top of the checked-out commit as a row of its own.
  const headCommit = commits.find((commit) => commit.refs.some((ref) => ref.head)) ?? (mode === 'auto' ? commits[0] : undefined);
  const dirty = uncommitted > 0 && headCommit ? { hash: '(working tree)', parents: [headCommit.hash] } : null;
  const layout = layoutGraph(dirty ? [dirty, ...commits] : commits);
  const width = graphWidth(layout.width);
  const rows: HTMLElement[] = [];
  let index = 0;
  if (dirty) {
    const graph = layout.rows[index++];
    const row = element('div', 'commit dirty');
    const head = element('div', 'head');
    if (graph) head.append(drawRowGraph(graph, width, 'dirty'));
    const text = element('div', 'text');
    const line = element('div', 'line');
    line.append(element('span', 'subject', 'Uncommitted changes'));
    text.append(line, element('div', 'meta', `${uncommitted} ${uncommitted === 1 ? 'file' : 'files'} not committed yet`));
    head.append(text);
    row.append(head);
    rows.push(row);
  }
  for (const commit of commits) {
    const graph = layout.rows[index++];
    const open = commit.hash === openHash;
    const row = element('div', open ? 'commit open' : 'commit');
    const head = element('button', 'head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.title = commit.subject;
    if (graph) head.append(drawRowGraph(graph, width, commit.refs.some((ref) => ref.head) ? 'head' : 'commit'));
    const text = element('div', 'text');
    const line = element('div', 'line');
    for (const ref of commit.refs) line.append(refBadge(ref.name, ref.kind, ref.head));
    line.append(element('span', 'subject', commit.subject));
    text.append(line, element('div', 'meta', `${commit.author} · ${commit.when}`));
    head.append(text);
    // One row open at a time; opening fetches its details once.
    head.addEventListener('click', () => {
      openHash = open ? null : commit.hash;
      render();
      if (openHash) void loadDetail(openHash);
    });
    row.append(head);
    if (open) {
      const detailsRow = element('div', 'details');
      if (graph) detailsRow.append(drawRail(graph, width));
      const card = element('div', 'card');
      renderDetail(card, commit);
      detailsRow.append(card);
      row.append(detailsRow);
    }
    rows.push(row);
  }
  list.replaceChildren(...rows);
  if (openHash) list.querySelector('.commit.open')?.scrollIntoView({ block: 'nearest' });
};

// ----- Host wiring -----

// The host sizes the frame to this, up to its maximum; beyond that the page scrolls.
let reportedHeight = -1;
new ResizeObserver(() => {
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height === reportedHeight) return;
  reportedHeight = height;
  void host.setHeight(height).catch(() => undefined);
}).observe(root);

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  locale = context.locale;
});

let directorySeen = false;
host.onDirectory((next) => {
  if (directorySeen && next === directory) return;
  directorySeen = true;
  directory = next;
  commits = []; refs = null; openHash = null; details.clear();
  void (async () => {
    if (next) await loadPrefs(next);
    if (directory !== next) return;
    tabs.update({ activeId: mode });
    void load();
  })();
});

// An agent turn that just finished may have committed; read the history again.
let lastPhase: SessionLifecyclePhase | null = null;
host.onSessionLifecycle((event) => {
  const finished = lastPhase === 'started' && event.phase === 'completed';
  lastPhase = event.phase;
  if (finished) void load();
});

render();
