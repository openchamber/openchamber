/**
 * The Markdown renderer.
 *
 * The document is meant to read like a conversation. A message carries its
 * text and nothing else; a tool call is one compact line; a subagent's work
 * sits where it was delegated, under a line that names the agent.
 *
 * The output is ordinary Markdown: no HTML, no script, no viewer. It reads
 * the same in GitHub, in Obsidian, in VS Code and in a plain text editor.
 *
 * The shape follows the conversation itself. The orchestrator's messages are
 * headings, so the reader can skim the thread; a subagent's messages are
 * bold lines, so they read as part of the message they belong to rather than
 * as a new section.
 */

import { getCurrentIntlLocale, type I18nKey } from '@/lib/i18n';
import { readTimestamp } from './values';
import type { ExportFinding } from './events';
import { orderingGuarantee } from './order';
import { exportText, findingText } from './i18n';
import type { ProjectedEntry, ProjectedNode, ProjectedSubagent, ProjectionMode } from './project';

/** The clock time of a timestamp, in the reader's locale. */
const formatTime = (timestamp: number | undefined): string => {
  const time = readTimestamp(timestamp);
  if (time === undefined) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(getCurrentIntlLocale(), { hour: '2-digit', minute: '2-digit' });
};

/** The date and clock time of a timestamp, in the reader's locale. */
const formatDateTime = (timestamp: number | undefined): string => {
  const time = readTimestamp(timestamp);
  if (time === undefined) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(getCurrentIntlLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** How long a call ran, when the source recorded both ends. */
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

/**
 * A block of text as a Markdown blockquote, so an excerpt reads as a quote of
 * the source rather than as part of the conversation.
 */
const asQuote = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

/** The time of an event, or an empty string when the source had none. */
const timeLabel = (timestamp: number | undefined): string => formatTime(timestamp);

/** The heading an orchestrator-level message gets. */
const messageHeading = (entry: ProjectedEntry & { kind: 'message' }, model?: string): string => {
  const label = roleLabel(entry.role);
  const time = timeLabel(entry.timestamp);
  const head = time ? `${time} · ${label}` : label;
  return model ? `### ${head} — ${model}` : `### ${head}`;
};

/**
 * The line a subagent's own message gets.
 *
 * A message the subagent itself wrote carries the subagent's own name, the
 * way the orchestrator's messages carry the orchestrator's. A message the
 * user wrote inside the subagent's session, or a record the runtime added,
 * keeps the role it was recorded with: it was not the subagent speaking.
 */
const subagentMessageLine = (
  entry: ProjectedEntry & { kind: 'message' },
  label: string,
  model?: string,
): string => {
  const time = timeLabel(entry.timestamp);
  const speaker = entry.role === 'assistant' ? label : roleLabel(entry.role);
  const head = time ? `${time} · ${speaker}` : speaker;
  return model ? `**${head} — ${model}**` : `**${head}**`;
};

/** The line a subagent's block gets. */
const subagentHeading = (subagent: ProjectedSubagent): string => {
  const label = subagent.agent ? `↳ ${subagent.agent}` : `↳ ${exportText('export.dialog.subagentLabel')}`;
  const time = timeLabel(subagent.startedAt);
  const title = subagent.title && subagent.title !== subagent.childSessionID ? ` — ${subagent.title}` : '';
  const head = time ? `${time} · ${label}` : label;
  return `**${head}${title}**`;
};

/** The line a subagent's own message gets. */
const subagentMessageLabel = (subagent: ProjectedSubagent): string => (
  subagent.agent ? `↳ ${subagent.agent}` : `↳ ${exportText('export.dialog.subagentLabel')}`
);

/** The compact line a tool call becomes. */
const toolLine = (tool: ProjectedNode & { kind: 'tool' }): string => {
  const parts: string[] = [`\`${tool.tool.name}\``];
  const status = statusLabel(tool.tool.status);
  parts.push(status);
  const duration = formatDuration(tool.tool.startedAt, tool.tool.endedAt);
  if (duration) parts.push(duration);
  const description = tool.tool.description ?? tool.tool.target ?? tool.tool.command;
  if (description) parts.push(description);
  return `*${parts.join(' · ')}*`;
};

/**
 * The files a message carried, as a list.
 *
 * A message that carried only files has no text but is not empty: the files
 * are what it said.
 */
const attachmentList = (entry: ProjectedEntry & { kind: 'message' }): string => (
  entry.attachments?.length
    ? entry.attachments.map((file) => `- ${file.filename ?? file.mime}`).join('\n')
    : ''
);

type MarkdownRenderOptions = {
  title: string;
  mode: ProjectionMode;
  findings: ExportFinding[];
  /** The sessions the export covered, for the header line. */
  sessionCount: number;
};

/**
 * Renders one projected entry at the orchestrator level.
 */
const renderEntry = (entry: ProjectedEntry, mode: ProjectionMode, model?: string): string => {
  switch (entry.kind) {
    case 'message': {
      const heading = messageHeading(entry, model);
      const body = entry.text.trim();
      const attachments = attachmentList(entry);
      if (!body && !attachments) return '';
      const sections = [heading];
      if (body) sections.push(body);
      if (attachments) sections.push(attachments);
      if (entry.shell) {
        const shell = entry.shell;
        const result = [
          shell.output ? asQuote(shell.output) : '',
          shell.status ? exportText('export.shell.status', { status: shell.status }) : '',
          shell.exit !== undefined ? exportText('export.shell.exit', { code: shell.exit }) : '',
        ].filter(Boolean).join('\n\n');
        if (result) sections.push(`**${exportText('export.section.result')}**\n\n${result}`);
      }
      return sections.join('\n\n');
    }
    case 'tool': {
      const line = toolLine(entry);
      const details: string[] = [];

      if (mode === 'detailed') {
        if (entry.tool.prompt) details.push(`**${exportText('export.section.task')}**\n\n${asQuote(entry.tool.prompt)}`);
        if (entry.tool.error) details.push(`**${exportText('export.section.error')}**\n\n${asQuote(entry.tool.error)}`);
        if (entry.tool.output) {
          const output = entry.tool.outputOmitted
            ? `${entry.tool.output}\n\n*[${exportText('export.restInJson')}]*`
            : entry.tool.output;
          details.push(`**${exportText('export.section.output')}**\n\n${asQuote(output)}`);
        }
        const { input, metadata } = entry.tool;
        if (Object.keys(input).length > 0) {
          details.push(`**${exportText('export.section.input')}**\n\n${asQuote(JSON.stringify(input, null, 2))}`);
        }
        if (metadata && Object.keys(metadata).length > 0) {
          details.push(`**${exportText('export.section.metadata')}**\n\n${asQuote(JSON.stringify(metadata, null, 2))}`);
        }
      } else {
        if (entry.tool.prompt) {
          const excerpt = entry.tool.prompt.length > 400
            ? `${entry.tool.prompt.slice(0, 400)}\n\n… [${exportText('export.excerpt')}]`
            : entry.tool.prompt;
          details.push(`**${exportText('export.section.task')}**\n\n${asQuote(excerpt)}`);
        }
        if (entry.tool.error) details.push(`**${exportText('export.section.error')}**\n\n${asQuote(entry.tool.error)}`);
        if (entry.tool.output) {
          const output = entry.tool.outputTruncated
            ? `${entry.tool.output}\n\n*[${exportText('export.excerpt')} — ${exportText('export.restInJson')}]*`
            : entry.tool.output;
          details.push(`**${exportText('export.section.result')}**\n\n${asQuote(output)}`);
        }
      }

      return [line, ...details].join('\n\n');
    }
    case 'reasoning': {
      if (mode !== 'detailed') return '';
      return `**${exportText('export.section.reasoning')}**\n\n${asQuote(entry.text)}`;
    }
    case 'subagent-result': {
      const label = entry.state === 'completed'
        ? `**${exportText('export.section.subagentResult')}**`
        : `**${exportText('export.section.subagentState', { state: entry.state })}**`;
      const output = entry.output.trim();
      const body = mode === 'readable' && output.length > 800
        ? `${output.slice(0, 800)}\n\n… [${exportText('export.excerpt')}]`
        : output;
      return [label, body].filter(Boolean).join('\n\n');
    }
    case 'gap': {
      return `*${entry.detail}*`;
    }
  }
};

/**
 * Renders the call that started a sub-agent, when the detailed view shows
 * the call's own record.
 *
 * The call's arguments, its metadata and its identifier are the record of
 * what the parent asked for. The block's own header says how the call ended;
 * this says what it carried.
 */
const renderDispatchCall = (dispatched: NonNullable<ProjectedSubagent['dispatchedBy']>): string[] => {
  const call = dispatched.call;
  if (!call) return [];
  const details: string[] = [];
  if (Object.keys(call.input).length > 0) {
    details.push(`**${exportText('export.section.input')}**\n\n${asQuote(JSON.stringify(call.input, null, 2))}`);
  }
  if (call.metadata && Object.keys(call.metadata).length > 0) {
    details.push(`**${exportText('export.section.metadata')}**\n\n${asQuote(JSON.stringify(call.metadata, null, 2))}`);
  }
  if (call.callID) {
    details.push(`**${exportText('export.section.callId')}**\n\n${asQuote(call.callID)}`);
  }
  return details;
};

/**
 * Renders a subagent's block: its heading, the call that started it, its own
 * entries, and its own subagents.
 */
const renderSubagent = (subagent: ProjectedSubagent, mode: ProjectionMode): string => {
  const parts: string[] = [subagentHeading(subagent)];

  if (subagent.concurrentWith && subagent.concurrentWith.length > 0) {
    parts.push(`*${exportText('export.concurrent', { names: subagent.concurrentWith.join(', ') })}*`);
  }

  // The task's own record carries what the first prompt carried besides its
  // text: the files it came with. A prompt that carried only files is still
  // a task, so the task line is shown even when there is no text to quote.
  const taskAttachments = subagent.taskEntry ? attachmentList(subagent.taskEntry) : '';
  if (subagent.task || taskAttachments) {
    const task = subagent.task
      ? (mode === 'readable' && subagent.task.length > 600
        ? `${subagent.task.slice(0, 600)}\n\n… [${exportText('export.excerpt')}]`
        : subagent.task)
      : '';
    parts.push(`**${exportText('export.section.task')}**\n\n${asQuote(task)}`.trimEnd());
  }
  if (taskAttachments) parts.push(taskAttachments);

  // The agent the call named, when it differs from the agent that ran: the
  // call asked for one agent, the session records the one that answered.
  if (subagent.invokedAs && subagent.invokedAs !== subagent.agent) {
    parts.push(`*${exportText('export.dispatch.invokedAs', { agent: subagent.invokedAs })}*`);
  }
  if (subagent.invokedDescription && subagent.invokedDescription !== subagent.title) {
    parts.push(`*${exportText('export.dispatch.invokedDescription', { description: subagent.invokedDescription })}*`);
  }

  // The call that started the sub-agent is not shown as a row of its own: its
  // content moved into this block. The block says how that call ended, so a
  // failed delegation is not silently missing.
  const dispatched = subagent.dispatchedBy;
  if (dispatched?.error) {
    parts.push(`*${exportText('export.dispatch.error', { error: dispatched.error })}*`);
  } else if (dispatched?.status) {
    parts.push(`*${exportText('export.dispatch.status', { status: statusLabel(dispatched.status) })}*`);
  }
  if (mode === 'detailed' && dispatched?.output) {
    parts.push(`**${exportText('export.dispatch.result')}**\n\n${asQuote(dispatched.output)}`);
  }
  if (mode === 'detailed' && dispatched) {
    parts.push(...renderDispatchCall(dispatched));
  }

  // A second call that named the same session resumed it. The transcript
  // appears once, and the block says that it was resumed.
  if (subagent.resumedBy && subagent.resumedBy.length > 0) {
    parts.push(`*${exportText('export.dispatch.resumed', { count: subagent.resumedBy.length })}*`);
  }

  const label = subagentMessageLabel(subagent);
  // The model is named on the first message of the block and again when it
  // changes. The parent's model does not carry over: a subagent ran on its
  // own model, and the reader has to see which.
  let lastModel: string | undefined;

  // The block's own sequence: the subagent's records and the blocks of the
  // subagents it started, in the order they happened. A nested block sits at
  // the call that started it, not after everything the parent said.
  for (const entry of subagent.entries) {
    if (entry.kind === 'subagent') {
      parts.push(renderSubagent(entry, mode));
      continue;
    }
    if (entry.kind === 'message') {
      const model = entry.model && entry.model !== lastModel ? entry.model : undefined;
      if (entry.model) lastModel = entry.model;
      const heading = subagentMessageLine(entry, label, model);
      const body = entry.text.trim();
      const attachments = attachmentList(entry);
      if (!body && !attachments) continue;
      parts.push([heading, body, attachments].filter(Boolean).join('\n\n'));
      continue;
    }
    const rendered = renderEntry(entry, mode);
    if (rendered) parts.push(rendered);
  }

  return parts.join('\n\n');
};

/** The findings, as one compact notice at the end of the document. */
const renderIntegrityNotice = (findings: ExportFinding[]): string => {
  if (findings.length === 0) return '';
  const lines = findings.map((finding) => `- ${findingText(finding.messageKey, finding.messageParams)}`);
  const summary = findings.length === 1
    ? exportText('export.integrity.summarySingle')
    : exportText('export.integrity.summaryPlural', { count: findings.length });
  return [
    `## ${exportText('export.integrity.heading')}`,
    '',
    summary,
    '',
    ...lines,
  ].join('\n');
};

/**
 * Renders the export as Markdown.
 */
export const renderExportMarkdown = (
  nodes: ProjectedNode[],
  options: MarkdownRenderOptions,
): string => {
  const { title, mode, findings } = options;
  const exportedAt = formatDateTime(Date.now());

  const header = [
    `# ${title}`,
    '',
    `*${options.sessionCount === 1 ? exportText('export.header.sessionSingle') : exportText('export.header.sessionsPlural', { count: options.sessionCount })} · ${mode === 'readable' ? exportText('export.header.view.readable') : exportText('export.header.view.detailed')} · ${exportText('export.header.exported', { time: exportedAt })}*`,
  ].join('\n');

  const body: string[] = [];
  let lastModel: string | undefined;

  for (const node of nodes) {
    if (node.kind === 'subagent') {
      body.push(renderSubagent(node, mode));
      continue;
    }
    if (node.kind === 'message') {
      const model = node.model && node.model !== lastModel ? node.model : undefined;
      if (node.model) lastModel = node.model;
      const rendered = renderEntry(node, mode, model);
      if (rendered) body.push(rendered);
      continue;
    }
    const rendered = renderEntry(node, mode);
    if (rendered) body.push(rendered);
  }

  const sections = [header, body.join('\n\n---\n\n')];

  const notice = renderIntegrityNotice(findings);
  if (notice) sections.push('---', notice);

  sections.push('---', `*${orderingGuarantee()}*`);

  return sections.join('\n\n');
};
