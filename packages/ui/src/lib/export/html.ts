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

import { getCurrentIntlLocale } from '@/lib/i18n';
import { readTimestamp } from './values';
import type { ExportExcludedSession, ExportFinding } from './events';
import { orderingStatement, type ConcurrentWork } from './order';
import { exportText, findingText } from './i18n';
import { agentLabel, concurrentLabel, excludedArchivedNote, messageAgent, readablePrompt, roleLabel, runtimeTruncationNote, statusLabel } from './labels';
import type { ProjectedEntry, ProjectedNode, ProjectedSubagent, ProjectedTool, ProjectionMode } from './project';

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
 * A prompt as the page shows it.
 *
 * The readable view cuts a long prompt down, and the page shows that cut. The
 * search index holds the same text, so a search finds what the reader can
 * read on the page and nothing else.
 */
const promptOnPage = (prompt: string, mode: ProjectionMode): string => (
  mode === 'readable' ? readablePrompt(prompt) : prompt
);

/** One entry as the page's script needs it. */
type EntryData = {
  id: string;
  kind: 'message' | 'tool' | 'reasoning' | 'subagent-result' | 'gap' | 'task' | 'call';
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
  concurrentWith?: ConcurrentWork[];
};

/** The data the page's script filters and searches over. */
type HtmlExportData = {
  entries: EntryData[];
  subagents: SubagentData[];
  agents: string[];
  tools: string[];
  statuses: string[];
  roles: string[];
  /**
   * The phrase the page counts its entries with, in the reader's language.
   *
   * The visible and the total counts are the two numbers of the phrase, and
   * the order of the words is the language's business.
   */
  countLabel: string;
};

/**
 * The text the page's search index holds for a tool call.
 *
 * The index holds what the page shows: a tool's arguments and metadata are
 * on the page in the detailed view, so a search for a word that only appears
 * there has to find the entry. The readable view cuts a long prompt down, so
 * the index holds that cut: a word the page does not show must not be found.
 */
const toolSearchText = (tool: ProjectedTool, mode: ProjectionMode): string => {
  const parts = [
    tool.name,
    tool.description ?? '',
    tool.output ?? '',
    tool.error ?? '',
    tool.prompt === undefined ? '' : promptOnPage(tool.prompt, mode),
    tool.target ?? '',
    tool.command ?? '',
  ];
  if (mode === 'detailed') {
    parts.push(JSON.stringify(tool.input));
    if (tool.metadata) parts.push(JSON.stringify(tool.metadata));
  }
  return parts.join(' ');
};

/**
 * The text the page's search index holds for one entry.
 *
 * The index holds what the page shows: a tool's arguments and metadata are
 * on the page in the detailed view, so a search for a word that only appears
 * there has to find the entry.
 */
const searchTextOf = (entry: ProjectedEntry, mode: ProjectionMode): string => {
  switch (entry.kind) {
    case 'message':
      return `${entry.role} ${entry.text}`;
    case 'tool':
      return toolSearchText(entry.tool, mode);
    case 'reasoning':
      // The readable view does not draw the reasoning, so the index must not
      // hold its text either: a search must not find a word the reader
      // cannot read. The detailed view draws it, and the index holds it.
      return mode === 'detailed' ? entry.text : '';
    case 'subagent-result':
      return `${entry.state} ${entry.description ?? ''} ${entry.output}`;
    case 'gap':
      return entry.detail;
  }
};

/**
 * The agent an entry belongs to.
 *
 * The filter's value and the document's label come from the same name, so a
 * reader who filters by an agent finds the entries the document shows under
 * that name.
 */
type EntryOwner = {
  /** The agent's name, when the session that owns the entry recorded one. */
  name?: string;
  /** Whether the entry sits inside a sub-agent's block. */
  nested: boolean;
};

/**
 * Builds the data the page's script works with.
 *
 * The agent list is read off the entries themselves, not off the sessions:
 * the filter compares `data-agent` on the page with the chosen value, so the
 * list has to hold exactly the values the page carries. An entry inside a
 * sub-agent's block belongs to that sub-agent, and the page says so, so the
 * list names the sub-agent and not the agent the message happened to record.
 * The root session's own entries belong to the root's agent, and the page
 * names that agent in them, so the filter offers the same name the document
 * shows.
 */
const buildData = (nodes: ProjectedNode[], mode: ProjectionMode, rootAgent?: string): HtmlExportData => {
  const entries: EntryData[] = [];
  const subagents: SubagentData[] = [];
  const tools = new Set<string>();
  const statuses = new Set<string>();
  const roles = new Set<string>();

  const visit = (node: ProjectedNode, owner: EntryOwner): void => {
    if (node.kind === 'subagent') {
      if (node.task) {
        entries.push({
          id: `${node.childSessionID}:task`,
          kind: 'task',
          agent: node.agent,
          search: promptOnPage(node.task, mode).toLowerCase(),
          depth: node.depth,
        });
      }
      // The call that started the sub-agent is shown in the block's header,
      // not as a row of its own. Its own record is still searchable, so a
      // word that only appears in the call's arguments finds the block. The
      // detailed view is the one that shows the arguments, so the readable
      // view does not promise them.
      const call = node.dispatchedBy?.call;
      if (call && mode === 'detailed') {
        entries.push({
          id: `${node.childSessionID}:call`,
          kind: 'call',
          agent: node.agent,
          tool: call.name,
          status: call.status,
          search: toolSearchText(call, mode).toLowerCase(),
          depth: node.depth,
          timestamp: call.startedAt,
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
      // The block's own sequence holds the nested blocks too, so the
      // entries are read from it and not from the child list as well.
      for (const entry of node.entries) visit(entry, { name: node.agent, nested: true });
      return;
    }
    visitEntry(node, owner);
  };

  const visitEntry = (entry: ProjectedEntry, owner: EntryOwner): void => {
    const id = entry.event.id;
    switch (entry.kind) {
      case 'message': {
        roles.add(entry.role);
        entries.push({
          id,
          kind: 'message',
          role: entry.role,
          // The same name the entry shows: the agent that wrote the message,
          // and the session's own agent as the fallback.
          agent: messageAgent(entry.agent, owner.name),
          model: entry.model,
          search: searchTextOf(entry, mode).toLowerCase(),
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
          // The owner is the session the call ran in, not the agent the call
          // asked for: a sub-agent's own tool calls belong to the sub-agent.
          agent: owner.name ?? entry.tool.agent,
          search: searchTextOf(entry, mode).toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
      case 'reasoning': {
        entries.push({
          id,
          kind: 'reasoning',
          search: searchTextOf(entry, mode).toLowerCase(),
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
          search: searchTextOf(entry, mode).toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
      case 'gap': {
        entries.push({
          id,
          kind: 'gap',
          search: searchTextOf(entry, mode).toLowerCase(),
          depth: entry.depth,
          timestamp: entry.timestamp,
        });
        return;
      }
    }
  };

  // The root session's own entries belong to the root agent, and the page
  // names that agent in them, so the filter offers the same name the
  // document shows.
  for (const node of nodes) visit(node, { name: rootAgent, nested: false });

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
    countLabel: exportText('export.html.count'),
  };
};

/**
 * The label an entry's header carries.
 *
 * A sub-agent's own message carries the sub-agent's name, the way the root's
 * messages carry the root agent's. A message the user wrote inside a
 * sub-agent's session, or a record the runtime added, keeps the role it was
 * recorded with: it was not the agent speaking.
 */
const ownerLabel = (owner: EntryOwner, agent?: string): string => (
  owner.nested
    ? `↳ ${messageAgent(agent, owner.name) ?? exportText('export.dialog.subagentLabel')}`
    : agentLabel(messageAgent(agent, owner.name))
);

/**
 * Renders one entry as HTML.
 *
 * `owner` names the agent whose message this is: inside a sub-agent's block
 * that is the sub-agent, not the root agent.
 */
const renderEntryHtml = (
  entry: ProjectedEntry,
  mode: ProjectionMode,
  owner: EntryOwner,
): string => {
  switch (entry.kind) {
    case 'message': {
      const label = entry.role === 'assistant'
        ? ownerLabel(owner, entry.agent)
        : roleLabel(entry.role);
      // The entry's agent: the message names the agent that wrote it, and
      // the session's own agent is the fallback. Inside a sub-agent's block
      // the block's name is the fallback too — the block's own header keeps
      // the session's name, and that is the block's identity.
      const agent = messageAgent(entry.agent, owner.name) ?? '';
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
      const shell = entry.shell
        ? `<details><summary>${escapeHtml(exportText('export.section.result'))}</summary><pre>${escapeHtml([
            entry.shell.output ?? '',
            entry.shell.status ?? '',
            entry.shell.exit !== undefined ? `exit ${entry.shell.exit}` : '',
          ].filter(Boolean).join('\n'))}</pre></details>`
        : '';
      return `<article class="entry message" data-id="${escapeHtml(entry.event.id)}" data-kind="message" data-role="${escapeHtml(entry.role)}" data-agent="${escapeHtml(agent)}" data-model="${escapeHtml(entry.model ?? '')}">
  <header><span class="role">${escapeHtml(label)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</header>
  ${body}${attachments}${shell}
</article>`;
    }
    case 'tool': {
      const status = statusLabel(entry.tool.status);
      const duration = formatDuration(entry.tool.startedAt, entry.tool.endedAt);
      const meta = [status, duration].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join('');
      const description = entry.tool.description ?? entry.tool.target ?? entry.tool.command ?? '';
      // The agent the call asked for, when the description does not name it.
      // The block that would name it is not in the document, so the row is
      // what the reader has.
      const agent = entry.tool.agent && entry.tool.agent !== description ? entry.tool.agent : '';
      const desc = [description, agent].filter(Boolean).join(' · ');
      const details: string[] = [];
      if (entry.tool.prompt) {
        const prompt = promptOnPage(entry.tool.prompt, mode);
        details.push(`<details><summary>${escapeHtml(exportText('export.section.task'))}</summary><pre>${escapeHtml(prompt)}</pre></details>`);
      }
      if (entry.tool.error) {
        details.push(`<details><summary>${escapeHtml(exportText('export.section.error'))}</summary><pre>${escapeHtml(entry.tool.error)}</pre></details>`);
      }
      if (entry.tool.output) {
        // The readable view's own cut is marked here, and the mark says where
        // the whole result is: the export of this session with full details.
        // The detailed view cuts nothing, so it has nothing to mark. The
        // runtime's own cut is marked in both: it belongs where the reader
        // sees the output.
        const truncationNote = runtimeTruncationNote(entry.tool);
        const notes = [
          entry.tool.outputTruncated
            ? `<p class="note">${escapeHtml(exportText('export.html.shownInPart'))}</p>`
            : '',
          truncationNote ? `<p class="note">${escapeHtml(truncationNote)}</p>` : '',
        ].join('');
        details.push(`<details><summary>${escapeHtml(exportText('export.section.output'))}</summary><pre>${escapeHtml(entry.tool.output)}</pre>${notes}</details>`);
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
      return `<article class="entry tool" data-id="${escapeHtml(entry.event.id)}" data-kind="tool" data-tool="${escapeHtml(entry.tool.name)}" data-status="${escapeHtml(entry.tool.status)}" data-agent="${escapeHtml(owner.name ?? entry.tool.agent ?? '')}">
  <header><span class="tool-name">${escapeHtml(entry.tool.name)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</header>
  ${desc ? `<div class="desc">${escapeHtml(desc)}</div>` : ''}
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
      // The readable view's own cut of the result is marked here, and the
      // mark says where the whole result is: the export of this session with
      // full details. The detailed view cuts nothing, so it has nothing to
      // mark. It is the same note an ordinary tool result carries.
      const note = entry.outputTruncated
        ? `<p class="note">${escapeHtml(exportText('export.html.shownInPart'))}</p>`
        : '';
      return `<article class="entry result" data-id="${escapeHtml(entry.event.id)}" data-kind="subagent-result" data-role="subagent-result" data-agent="">
  <header><span class="role">${escapeHtml(label)}</span><span class="meta"><span>${escapeHtml(entry.description ?? '')}</span></span></header>
  <div class="body">${escapeHtml(entry.output)}</div>
  ${note}
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
  const blockLabel = subagent.agent ? `↳ ${subagent.agent}` : `↳ ${exportText('export.dialog.subagentLabel')}`;
  const label = blockLabel;
  const time = formatTime(subagent.startedAt);
  const duration = formatDuration(subagent.startedAt, subagent.endedAt);
  const meta = [time, duration].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join('');
  const title = subagent.title && subagent.title !== subagent.childSessionID
    ? `<span class="subagent-title">${escapeHtml(subagent.title)}</span>`
    : '';
  const concurrent = subagent.concurrentWith && subagent.concurrentWith.length > 0
    ? `<p class="note">${escapeHtml(exportText('export.concurrent', { names: subagent.concurrentWith.map(concurrentLabel).join(', ') }))}</p>`
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
  // The runtime cut the call's result short. The same fact an ordinary tool
  // call carries, on the call that started this sub-agent.
  const dispatchTruncation = dispatched?.call ? runtimeTruncationNote(dispatched.call) : '';
  const dispatchTruncationNote = dispatchTruncation
    ? `<p class="note">${escapeHtml(dispatchTruncation)}</p>`
    : '';
  const dispatchDetails = renderDispatchCallDetails(subagent, mode);

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
  // the task and hides the rest of the block. The index holds the text the
  // page shows, so a word the page cut away is not found.
  const task = subagent.task
    ? `<article class="entry task" data-id="${escapeHtml(`${subagent.childSessionID}:task`)}" data-kind="task" data-agent="${escapeHtml(subagent.agent ?? '')}">
  <header><span class="role">${escapeHtml(exportText('export.section.task'))}</span></header>
  <pre>${escapeHtml(promptOnPage(subagent.task, mode))}</pre>
</article>`
    : '';

  // The block's own sequence: the subagent's records and the blocks of the
  // subagents it started, in the order they happened. A nested block sits at
  // the call that started it, not after everything the parent said.
  const own = subagent.entries
    .map((entry) => (entry.kind === 'subagent'
      ? renderSubagentHtml(entry, mode, depth + 1)
      : renderEntryHtml(entry, mode, { name: subagent.agent, nested: true })))
    .filter(Boolean)
    .join('\n');

  // The transcript folds away: the reader who wants the thread opens it.
  // A native details element does that without any script, so the page
  // works offline, and the entries inside stay in the document, so the
  // search and the filters still reach them.
  //
  // The label, the title and the time are three elements of their own, so
  // the summary's own gap keeps them apart: the time does not run into the
  // title. An entry's header separates its metadata the same way.
  return `<section class="subagent depth-${depth}" data-id="${escapeHtml(subagent.childSessionID)}" data-agent="${escapeHtml(subagent.agent ?? '')}">
  <details open><summary><span class="subagent-label">${escapeHtml(label)}</span>${title}${meta ? `<span class="meta">${meta}</span>` : ''}</summary>
  ${concurrent}
  ${dispatchNote}
  ${dispatchResult}
  ${dispatchTruncationNote}
  ${dispatchDetails}
  ${invoked}
  ${task}
${own}
  </details>
</section>`;
};

/**
 * The call that started a sub-agent, as the detailed view shows it.
 *
 * The call's arguments, its metadata and its identifier are the record of
 * what the parent asked for. The call is an entry of its own, so a search
 * for a word in the arguments keeps the call and hides the rest of the
 * block.
 */
const renderDispatchCallDetails = (
  subagent: ProjectedSubagent,
  mode: ProjectionMode,
): string => {
  const call = subagent.dispatchedBy?.call;
  if (!call || mode !== 'detailed') return '';
  const details: string[] = [];
  if (Object.keys(call.input).length > 0) {
    details.push(`<details><summary>${escapeHtml(exportText('export.section.input'))}</summary><pre>${escapeHtml(JSON.stringify(call.input, null, 2))}</pre></details>`);
  }
  if (call.metadata && Object.keys(call.metadata).length > 0) {
    details.push(`<details><summary>${escapeHtml(exportText('export.section.metadata'))}</summary><pre>${escapeHtml(JSON.stringify(call.metadata, null, 2))}</pre></details>`);
  }
  if (call.callID) {
    details.push(`<details><summary>${escapeHtml(exportText('export.section.callId'))}</summary><pre>${escapeHtml(call.callID)}</pre></details>`);
  }
  if (details.length === 0) return '';
  return `<article class="entry call" data-id="${escapeHtml(`${subagent.childSessionID}:call`)}" data-kind="call" data-tool="${escapeHtml(call.name)}" data-status="${escapeHtml(call.status)}" data-agent="${escapeHtml(subagent.agent ?? '')}">
  <header><span class="tool-name">${escapeHtml(call.name)}</span><span class="meta"><span>${escapeHtml(statusLabel(call.status))}</span></span></header>
  ${details.join('\n  ')}
</article>`;
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
.bar .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
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
.subagent > details > summary { font-size: 1.05rem; display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; color: var(--fg); }
.subagent .subagent-title { color: var(--muted); font-weight: 400; font-size: .9rem; }
.files { margin: .5rem 0 0; padding-left: 1.1rem; color: var(--muted); font-size: .85rem; }
.integrity { border: 1px solid var(--border); border-left: 3px solid #d08700; border-radius: .5rem; padding: .7rem .85rem; margin-top: 1.5rem; background: var(--card); }
.integrity ul { margin: .4rem 0 0; padding-left: 1.1rem; }
.integrity li { margin-bottom: .2rem; }
.order-note { color: var(--muted); font-size: .8rem; margin-top: 1.5rem; }
.hidden { display: none !important; }
.count { color: var(--muted); font-size: .8rem; }
`;

/** The page's own script: search, filters, and the visible count. */
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('export-data').textContent);
  var entries = Array.prototype.slice.call(document.querySelectorAll('.entry'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('.subagent'));
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

    // A section whose entries are all hidden is hidden too, so an empty
    // sub-agent block does not sit on the page while the reader searches.
    // A match anywhere under a block keeps that block and every block above
    // it on the page: a match inside a nested block belongs to the reader,
    // and hiding the block above it would take the match away while the
    // counter still counts it.
    sections.forEach(function (section) {
      var anyVisible = Array.prototype.slice.call(section.querySelectorAll('.entry')).some(function (entry) {
        return !entry.classList.contains('hidden');
      });
      section.classList.toggle('hidden', !anyVisible);
    });

    count.textContent = data.countLabel
      .replace('{visible}', String(visible))
      .replace('{total}', String(entries.length));
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
  /**
   * The sessions the export left out on purpose, and why.
   *
   * The page says so as a fact, once, under the header: the export carries
   * the tree the app shows, and an archived session is not in it.
   */
  excluded: ExportExcludedSession[];
  /**
   * The agent the exported session ran.
   *
   * The document names the agent in its own messages instead of a role of
   * its own, because the agent has a name and the reader knows it.
   */
  rootAgent?: string;
};

/**
 * Renders the export as a self-contained HTML document.
 */
export const renderExportHtml = (
  nodes: ProjectedNode[],
  options: HtmlRenderOptions,
): string => {
  const data = buildData(nodes, options.mode, options.rootAgent);
  const body = nodes
    .map((node) => (node.kind === 'subagent'
      ? renderSubagentHtml(node, options.mode, node.depth)
      : renderEntryHtml(node, options.mode, { name: options.rootAgent, nested: false })))
    .filter((html) => html.trim().length > 0)
    .join('\n');

  const integrity = options.findings.length > 0
    ? `<section class="integrity">
  <h3>${escapeHtml(exportText('export.integrity.heading'))}</h3>
  <p>${escapeHtml(options.findings.length === 1
    ? exportText('export.integrity.summarySingle')
    : exportText('export.integrity.summaryPlural', { count: options.findings.length }))}</p>
  <ul>${options.findings.map((finding) => `<li>${escapeHtml(findingText(finding.messageKey, finding.messageParams))}</li>`).join('')}</ul>
</section>`
    : '';

  const sessionLabel = options.sessionCount === 1
    ? exportText('export.header.sessionSingle')
    : exportText('export.header.sessionsPlural', { count: options.sessionCount });

  // The sessions the export left out on purpose. The page says so once,
  // under the header, where the reader learns what the export covers: it is
  // a fact about the coverage, not a finding about a hole in the history.
  const excludedNote = excludedArchivedNote(options.excluded);
  const excludedLine = excludedNote
    ? `  <p class="note">${escapeHtml(excludedNote)}</p>\n`
    : '';

  // The page speaks the reader's language, so it declares that language: a
  // screen reader reads the text in the voice of the language the page names,
  // and the browser's spell checker and hyphenation follow it too.
  return `<!DOCTYPE html>
<html lang="${escapeHtml(getCurrentIntlLocale())}">
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
${excludedLine}  <div class="bar">
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
  <p class="order-note">${escapeHtml(orderingStatement())}</p>
</main>
<script type="application/json" id="export-data">${jsonForScript(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
};
