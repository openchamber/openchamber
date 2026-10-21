/**
 * The HTML renderer.
 *
 * The HTML export is the same history as the Markdown export, in a document
 * that can be read offline: no network, no external stylesheet, no script
 * from anywhere else. It adds what a screen can do that a text file cannot:
 * expandable tool details, a search box over messages and tool output, and
 * filters for agent, tool, status and message type.
 *
 * The document holds the data in one JSON block, and the page's own script
 * reads it. A large session is a long document, but the browser handles it:
 * the entries are plain elements, and the filters only hide them.
 */

import { getCurrentIntlLocale, type I18nKey } from '@/lib/i18n';
import { readTimestamp } from './values';
import type { ExportFinding } from './events';
import { orderingGuarantee } from './order';
import { exportText } from './i18n';
import type { ProjectedEntry, ProjectedNode, ProjectedSubagent, ProjectionMode } from './project';

/** Escapes text for an HTML text node or attribute. */
const escapeHtml = (text: string): string => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** A JSON string that is safe to put inside a `<script>` block. */
const jsonForScript = (value: HtmlExportData): string => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

const formatTime = (timestamp: number | undefined): string => {
  const time = readTimestamp(timestamp);
  if (time === undefined) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(getCurrentIntlLocale(), { hour: '2-digit', minute: '2-digit' });
};

const formatDateTime = (timestamp: number | undefined): string => {
  const time = readTimestamp(timestamp);
  if (time === undefined) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(getCurrentIntlLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const formatDuration = (startedAt?: number, endedAt?: number): string => {
  if (startedAt === undefined || endedAt === undefined) return '';
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
};

/**
 * The label a role's messages carry in the export.
 *
 * The label is resolved when the document is written, not when the module is
 * loaded, so the document speaks the reader's current language.
 */
const ROLE_LABEL_KEYS = new Map<string, I18nKey>([
  ['user', 'export.role.user'],
  ['assistant', 'export.role.assistant'],
  ['context', 'export.role.context'],
  ['system', 'export.role.system'],
  ['skill', 'export.role.skill'],
  ['shell', 'export.role.shell'],
  ['compaction', 'export.role.compaction'],
  ['agent-switched', 'export.role.agentSwitched'],
  ['model-switched', 'export.role.modelSwitched'],
  ['location-switched', 'export.role.locationSwitched'],
  ['idle', 'export.role.idle'],
]);

/** The label of a role, when the export knows one. */
const roleLabel = (role: string): string => {
  const key = ROLE_LABEL_KEYS.get(role);
  return key ? exportText(key) : role;
};

/** The label of a status, when the export knows one. */
const statusLabel = (status: string): string => {
  const key = STATUS_LABEL_KEYS.get(status);
  return key ? exportText(key) : status;
};

/** The label a tool call's status carries in the export. */
const STATUS_LABEL_KEYS = new Map<string, I18nKey>([
  ['pending', 'export.toolStatus.pending'],
  ['running', 'export.toolStatus.running'],
  ['completed', 'export.toolStatus.completed'],
  ['error', 'export.toolStatus.error'],
]);

/** One entry as the page's script needs it. */
type EntryData = {
  id: string;
  kind: 'message' | 'tool' | 'reasoning' | 'subagent-result' | 'gap' | 'task';
  role?: string;
  agent?: string;
  model?: string;
  tool?: string;
  status?: string;
  search: string;
  depth: number;
  timestamp?: number;
};

type SubagentData = {
  id: string;
  title: string;
  agent?: string;
  depth: number;
  startedAt?: number;
  endedAt?: number;
  concurrentWith?: string[];
};

/** The data the page's script filters and searches over. */
type HtmlExportData = {
  entries: EntryData[];
  subagents: SubagentData[];
  agents: string[];
  tools: string[];
  statuses: string[];
  roles: string[];
  /** The word the page counts its entries with, in the reader's language. */
  entriesLabel: string;
};

/**
 * Builds the data the page's script works with.
 *
 * The agent list is read off the entries themselves, not off the sessions:
 * the filter compares `data-agent` on the page with the chosen value, so the
 * list has to hold exactly the values the page carries. A message inside a
 * sub-agent's block belongs to that sub-agent, and the page says so, so the
 * list names the sub-agent and not the agent the message happened to record.
 */
const buildData = (nodes: ProjectedNode[]): HtmlExportData => {
  const entries: EntryData[] = [];
  const subagents: SubagentData[] = [];
  const tools = new Set<string>();
  const statuses = new Set<string>();
  const roles = new Set<string>();

  const visit = (node: ProjectedNode, owningAgent?: string): void => {
    if (node.kind === 'subagent') {
      if (node.task) {
        entries.push({
          id: `${node.childSessionID}:task`,
          kind: 'task',
          agent: node.agent,
          search: node.task.toLowerCase(),
          depth: node.depth,
        });
      }
      subagents.push({
        id: node.childSessionID,
        title: node.title,
        agent: node.agent,
        depth: node.depth,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        concurrentWith: node.concurrentWith,
      });
      for (const entry of node.entries) visit(entry, node.agent);
      for (const child of node.children) visit(child, node.agent);
      return;
    }
    visitEntry(node, owningAgent);
  };

  const visitEntry = (entry: ProjectedEntry, owningAgent?: string): void => {
    const id = entry.event.id;
    switch (entry.kind) {
      case 'message': {
        roles.add(entry.role);
        entries.push({
          id,
          kind: 'message',
          role: entry.role,
          agent: owningAgent ?? entry.agent,
          model: entry.model,
          search: `${entry.role} ${entry.text}`.toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
      case 'tool': {
        tools.add(entry.tool.name);
        statuses.add(entry.tool.status);
        entries.push({
          id,
          kind: 'tool',
          tool: entry.tool.name,
          status: entry.tool.status,
          agent: entry.tool.agent,
          search: `${entry.tool.name} ${entry.tool.description ?? ''} ${entry.tool.output ?? ''} ${entry.tool.error ?? ''} ${entry.tool.prompt ?? ''}`.toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
      case 'reasoning': {
        entries.push({
          id,
          kind: 'reasoning',
          search: entry.text.toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
      case 'subagent-result': {
        roles.add('subagent-result');
        entries.push({
          id,
          kind: 'subagent-result',
          role: 'subagent-result',
          search: `${entry.state} ${entry.description ?? ''} ${entry.output}`.toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
      case 'gap': {
        entries.push({
          id,
          kind: 'gap',
          search: entry.detail.toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
    }
  };

  for (const node of nodes) visit(node);

  // The agents the page's own attributes name. An entry without an agent
  // carries an empty attribute, which no filter offers.
  const agents = new Set<string>();
  for (const entry of entries) {
    if (entry.agent) agents.add(entry.agent);
  }

  return {
    entries,
    subagents,
    agents: [...agents].sort(),
    tools: [...tools].sort(),
    statuses: [...statuses].sort(),
    roles: [...roles].sort(),
    entriesLabel: exportText('export.html.entries'),
  };
};

/**
 * Renders one entry as HTML.
 *
 * `agentLabel` names the agent whose message this is: inside a sub-agent's
 * block that is the sub-agent, not the orchestrator.
 */
const renderEntryHtml = (entry: ProjectedEntry, mode: ProjectionMode, agentLabel?: string, agentKey?: string): string => {
  switch (entry.kind) {
    case 'message': {
      const label = agentLabel ?? roleLabel(entry.role);
      // Inside a sub-agent's block the entry belongs to that sub-agent, so
      // the filter names the sub-agent and not the agent the message
      // happened to record.
      const agent = agentKey ?? entry.agent ?? '';
      const time = formatTime(entry.timestamp);
      const model = entry.model;
      const meta = [time, model]
        .filter((value): value is string => Boolean(value))
        .map((value) => `<span>${escapeHtml(value)}</span>`)
        .join('');
      const attachments = entry.attachments?.length
        ? `<ul class="files">${entry.attachments.map((file) => `<li>${escapeHtml(file.filename ?? file.mime)}</li>`).join('')}</ul>`
        : '';
      const body = entry.text
        ? `<div class="body">${escapeHtml(entry.text)}</div>`
        : '';
      return `<article class="entry message" data-id="${escapeHtml(entry.event.id)}" data-kind="message" data-role="${escapeHtml(entry.role)}" data-agent="${escapeHtml(agent)}" data-model="${escapeHtml(entry.model ?? '')}">
  <header><span class="role">${escapeHtml(label)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</header>
  ${body}${attachments}
</article>`;
    }
    case 'tool': {
      const status = statusLabel(entry.tool.status);
      const duration = formatDuration(entry.tool.startedAt, entry.tool.endedAt);
      const meta = [status, duration].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join('');
      const description = entry.tool.description ?? entry.tool.target ?? entry.tool.command ?? '';
      const details: string[] = [];
      if (entry.tool.prompt) {
        details.push(`<details><summary>${escapeHtml(exportText('export.section.task'))}</summary><pre>${escapeHtml(entry.tool.prompt)}</pre></details>`);
      }
      if (entry.tool.error) {
        details.push(`<details><summary>${escapeHtml(exportText('export.section.error'))}</summary><pre>${escapeHtml(entry.tool.error)}</pre></details>`);
      }
      if (entry.tool.output) {
        const note = entry.tool.outputTruncated
          ? `<p class="note">${escapeHtml(exportText('export.html.shownInPart'))}</p>`
          : '';
        details.push(`<details><summary>${escapeHtml(exportText('export.section.output'))}</summary><pre>${escapeHtml(entry.tool.output)}</pre>${note}</details>`);
      }
      // The detailed view carries what the readable one leaves out: the
      // call's own arguments and the metadata the runtime reported.
      if (mode === 'detailed') {
        const { input, metadata } = entry.tool;
        if (Object.keys(input).length > 0) {
          details.push(`<details><summary>${escapeHtml(exportText('export.section.input'))}</summary><pre>${escapeHtml(JSON.stringify(input, null, 2))}</pre></details>`);
        }
        if (metadata && Object.keys(metadata).length > 0) {
          details.push(`<details><summary>${escapeHtml(exportText('export.section.metadata'))}</summary><pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre></details>`);
        }
      }
      return `<article class="entry tool" data-id="${escapeHtml(entry.event.id)}" data-kind="tool" data-tool="${escapeHtml(entry.tool.name)}" data-status="${escapeHtml(entry.tool.status)}" data-agent="${escapeHtml(entry.tool.agent ?? '')}">
  <header><span class="tool-name">${escapeHtml(entry.tool.name)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</header>
  ${description ? `<div class="desc">${escapeHtml(description)}</div>` : ''}
  ${details.join('\n  ')}
</article>`;
    }
    case 'reasoning': {
      if (mode !== 'detailed') return '';
      return `<article class="entry reasoning" data-id="${escapeHtml(entry.event.id)}" data-kind="reasoning">
  <details><summary>${escapeHtml(exportText('export.section.reasoning'))}</summary><pre>${escapeHtml(entry.text)}</pre></details>
</article>`;
    }
    case 'subagent-result': {
      const label = entry.state === 'completed'
        ? exportText('export.section.subagentResult')
        : exportText('export.section.subagentState', { state: entry.state });
      return `<article class="entry result" data-id="${escapeHtml(entry.event.id)}" data-kind="subagent-result" data-role="subagent-result" data-agent="">
  <header><span class="role">${escapeHtml(label)}</span><span class="meta"><span>${escapeHtml(entry.description ?? '')}</span></span></header>
  <div class="body">${escapeHtml(entry.output)}</div>
</article>`;
    }
    case 'gap': {
      return `<article class="entry gap" data-id="${escapeHtml(entry.event.id)}" data-kind="gap">
  <div class="body">${escapeHtml(entry.detail)}</div>
</article>`;
    }
  }
};

/** Renders a subagent's block as HTML. */
const renderSubagentHtml = (subagent: ProjectedSubagent, mode: ProjectionMode, depth: number): string => {
  const agentLabel = subagent.agent ? `↳ ${subagent.agent}` : `↳ ${exportText('export.dialog.subagentLabel')}`;
  const label = agentLabel;
  const time = formatTime(subagent.startedAt);
  const duration = formatDuration(subagent.startedAt, subagent.endedAt);
  const meta = [time, duration].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join('');
  const title = subagent.title && subagent.title !== subagent.childSessionID
    ? `<span class="subagent-title">${escapeHtml(subagent.title)}</span>`
    : '';
  const concurrent = subagent.concurrentWith && subagent.concurrentWith.length > 0
    ? `<p class="note">${escapeHtml(exportText('export.concurrent', { names: subagent.concurrentWith.join(', ') }))}</p>`
    : '';

  // The call that started the sub-agent is not a row of its own: its content
  // moved into this block. The block says how that call ended, so a failed
  // delegation is not silently missing.
  const dispatched = subagent.dispatchedBy;
  const dispatchNote = dispatched?.error
    ? `<p class="note">${escapeHtml(exportText('export.dispatch.error', { error: dispatched.error }))}</p>`
    : dispatched?.status
      ? `<p class="note">${escapeHtml(exportText('export.dispatch.status', { status: statusLabel(dispatched.status) }))}</p>`
      : '';
  const dispatchResult = mode === 'detailed' && dispatched?.output
    ? `<details><summary>${escapeHtml(exportText('export.dispatch.result'))}</summary><pre>${escapeHtml(dispatched.output)}</pre></details>`
    : '';

  // The agent the call named, when it differs from the agent that ran: the
  // call asked for one agent, the session records the one that answered.
  const invoked = [
    subagent.invokedAs && subagent.invokedAs !== subagent.agent
      ? `<p class="note">${escapeHtml(exportText('export.dispatch.invokedAs', { agent: subagent.invokedAs }))}</p>`
      : '',
    subagent.invokedDescription && subagent.invokedDescription !== subagent.title
      ? `<p class="note">${escapeHtml(exportText('export.dispatch.invokedDescription', { description: subagent.invokedDescription }))}</p>`
      : '',
    // A second call that named the same session resumed it. The transcript
    // appears once, and the block says that it was resumed.
    subagent.resumedBy && subagent.resumedBy.length > 0
      ? `<p class="note">${escapeHtml(exportText('export.dispatch.resumed', { count: subagent.resumedBy.length }))}</p>`
      : '',
  ].join('');

  // The task is an entry of its own, so a search for a word in it keeps
  // the task and hides the rest of the block.
  const task = subagent.task
    ? `<article class="entry task" data-id="${escapeHtml(`${subagent.childSessionID}:task`)}" data-kind="task" data-agent="${escapeHtml(subagent.agent ?? '')}">
  <header><span class="role">${escapeHtml(exportText('export.section.task'))}</span></header>
  <pre>${escapeHtml(subagent.task)}</pre>
</article>`
    : '';
  const entries = subagent.entries
    .map((entry) => renderEntryHtml(entry, mode, agentLabel, subagent.agent))
    .filter(Boolean)
    .join('\n');
  const children = subagent.children
    .map((child) => renderSubagentHtml(child, mode, depth + 1))
    .join('\n');

  return `<section class="subagent depth-${depth}" data-id="${escapeHtml(subagent.childSessionID)}" data-agent="${escapeHtml(subagent.agent ?? '')}">
  <h2>${escapeHtml(label)} ${title}${meta ? `<span class="meta">${meta}</span>` : ''}</h2>
  ${concurrent}
  ${dispatchNote}
  ${dispatchResult}
  ${invoked}
  ${task}
${entries}
${children}
</section>`;
};

/** The page's own stylesheet. */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #16181d;
  --muted: #5c6370;
  --border: #e2e5ea;
  --card: #f7f8fa;
  --accent: #2f6feb;
  --subagent: #f0f4fb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e7e9ee;
    --muted: #99a1b0;
    --border: #2a2e36;
    --card: #1b1e24;
    --accent: #7aa2f7;
    --subagent: #1a1f2a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 4rem;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem 0; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
h3 { font-size: .95rem; margin: 0 0 .35rem; }
.subtitle { color: var(--muted); font-size: .85rem; margin: 0 0 1rem; }
.bar {
  position: sticky; top: 0; z-index: 5; background: var(--bg);
  border-bottom: 1px solid var(--border); padding: .6rem 0; margin-bottom: 1rem;
}
.bar .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
input[type="search"], select {
  font: inherit; font-size: .85rem; padding: .35rem .5rem;
  border: 1px solid var(--border); border-radius: .35rem; background: var(--bg); color: var(--fg);
}
input[type="search"] { min-width: 14rem; }
.entry { border: 1px solid var(--border); border-radius: .5rem; padding: .7rem .85rem; margin: 0 0 .7rem; background: var(--card); }
.entry header { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .4rem; }
.entry .role, .entry .tool-name { font-weight: 600; }
.meta { color: var(--muted); font-size: .8rem; display: inline-flex; gap: .5rem; }
.entry .body, .entry .desc { white-space: pre-wrap; overflow-wrap: anywhere; }
.entry .desc { color: var(--muted); font-size: .85rem; }
.entry.gap { border-style: dashed; color: var(--muted); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--border); border-radius: .35rem; padding: .6rem; font-size: .82rem; max-height: 30rem; overflow: auto; }
details { margin-top: .5rem; }
summary { cursor: pointer; font-size: .85rem; color: var(--accent); }
.note { color: var(--muted); font-size: .8rem; margin: .4rem 0 0; }
.subagent { border-left: 3px solid var(--accent); padding-left: .8rem; margin: 1rem 0 1.2rem; }
.subagent.depth-2 { border-left-color: #9a6ef0; }
.subagent.depth-3 { border-left-color: #3fa7a0; }
.subagent .subagent-title { color: var(--muted); font-weight: 400; font-size: .9rem; }
.files { margin: .5rem 0 0; padding-left: 1.1rem; color: var(--muted); font-size: .85rem; }
.integrity { border: 1px solid var(--border); border-left: 3px solid #d08700; border-radius: .5rem; padding: .7rem .85rem; margin-top: 1.5rem; background: var(--card); }
.integrity ul { margin: .4rem 0 0; padding-left: 1.1rem; }
.integrity li { margin-bottom: .2rem; }
.guarantee { color: var(--muted); font-size: .8rem; margin-top: 1.5rem; }
.hidden { display: none !important; }
.count { color: var(--muted); font-size: .8rem; }
`;

/** The page's own script: search, filters, and the visible count. */
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('export-data').textContent);
  var entries = Array.prototype.slice.call(document.querySelectorAll('.entry'));
  var byId = {};
  data.entries.forEach(function (item) { byId[item.id] = item; });

  var search = document.getElementById('search');
  var agentFilter = document.getElementById('filter-agent');
  var toolFilter = document.getElementById('filter-tool');
  var statusFilter = document.getElementById('filter-status');
  var roleFilter = document.getElementById('filter-role');
  var count = document.getElementById('count');

  function fill(select, values) {
    values.forEach(function (value) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  }
  fill(agentFilter, data.agents);
  fill(toolFilter, data.tools);
  fill(statusFilter, data.statuses);
  fill(roleFilter, data.roles);

  function apply() {
    var term = (search.value || '').trim().toLowerCase();
    var agent = agentFilter.value;
    var tool = toolFilter.value;
    var status = statusFilter.value;
    var role = roleFilter.value;
    var visible = 0;

    entries.forEach(function (entry) {
      var record = byId[entry.dataset.id];
      if (!record) return;
      var matches = true;
      if (term && record.search.indexOf(term) === -1) matches = false;
      if (matches && agent && entry.dataset.agent !== agent) matches = false;
      if (matches && tool && entry.dataset.tool !== tool) matches = false;
      if (matches && status && entry.dataset.status !== status) matches = false;
      if (matches && role && entry.dataset.role !== role) matches = false;
      entry.classList.toggle('hidden', !matches);
      if (matches) visible += 1;
    });

    count.textContent = visible + ' of ' + entries.length + ' ' + data.entriesLabel;
  }

  [search, agentFilter, toolFilter, statusFilter, roleFilter].forEach(function (control) {
    control.addEventListener('input', apply);
    control.addEventListener('change', apply);
  });
  apply();
})();
`;

type HtmlRenderOptions = {
  title: string;
  mode: ProjectionMode;
  findings: ExportFinding[];
  sessionCount: number;
};

/**
 * Renders the export as a self-contained HTML document.
 */
export const renderExportHtml = (
  nodes: ProjectedNode[],
  options: HtmlRenderOptions,
): string => {
  const data = buildData(nodes);
  const body = nodes
    .map((node) => (node.kind === 'subagent'
      ? renderSubagentHtml(node, options.mode, node.depth)
      : renderEntryHtml(node, options.mode)))
    .filter((html) => html.trim().length > 0)
    .join('\n');

  const integrity = options.findings.length > 0
    ? `<section class="integrity">
  <h3>${escapeHtml(exportText('export.integrity.heading'))}</h3>
  <p>${escapeHtml(options.findings.length === 1
    ? exportText('export.integrity.summarySingle')
    : exportText('export.integrity.summaryPlural', { count: options.findings.length }))}</p>
  <ul>${options.findings.map((finding) => `<li>${escapeHtml(finding.detail)}</li>`).join('')}</ul>
</section>`
    : '';

  const sessionLabel = options.sessionCount === 1
    ? exportText('export.header.sessionSingle')
    : exportText('export.header.sessionsPlural', { count: options.sessionCount });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(options.title)}</h1>
  <p class="subtitle">${escapeHtml(sessionLabel)} · ${escapeHtml(options.mode === 'readable' ? exportText('export.header.view.readable') : exportText('export.header.view.detailed'))} · ${escapeHtml(exportText('export.header.exported', { time: formatDateTime(Date.now()) ?? '' }))}</p>
  <div class="bar">
    <div class="row">
      <input type="search" id="search" placeholder="${escapeHtml(exportText('export.html.searchPlaceholder'))}" aria-label="${escapeHtml(exportText('export.html.searchLabel'))}">
      <select id="filter-agent" aria-label="${escapeHtml(exportText('export.html.filterAgent'))}"><option value="">${escapeHtml(exportText('export.html.allAgents'))}</option></select>
      <select id="filter-tool" aria-label="${escapeHtml(exportText('export.html.filterTool'))}"><option value="">${escapeHtml(exportText('export.html.allTools'))}</option></select>
      <select id="filter-status" aria-label="${escapeHtml(exportText('export.html.filterStatus'))}"><option value="">${escapeHtml(exportText('export.html.allStatuses'))}</option></select>
      <select id="filter-role" aria-label="${escapeHtml(exportText('export.html.filterRole'))}"><option value="">${escapeHtml(exportText('export.html.allRoles'))}</option></select>
      <span class="count" id="count"></span>
    </div>
  </div>
  ${body}
  ${integrity}
  <p class="guarantee">${escapeHtml(orderingGuarantee())}</p>
</main>
<script type="application/json" id="export-data">${jsonForScript(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
};
