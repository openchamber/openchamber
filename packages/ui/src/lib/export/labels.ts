/**
 * The export document's own labels.
 *
 * The Markdown and the HTML render the same history, and a reader compares
 * the two: a name that differs between the formats reads as two different
 * things. The labels therefore live here, in one place, and both renderers
 * read them.
 *
 * The text is resolved when the document is written, not when the module is
 * loaded, so the document speaks the reader's current language.
 */

import type { I18nKey } from '@/lib/i18n';
import { exportText } from './i18n';
import type { ConcurrentWork } from './order';

/**
 * The label a role's messages carry in the export.
 *
 * The assistant role has no label of its own: the document names the agent
 * that produced the message, because the agent has a name and a made-up
 * role would be a claim the history does not support.
 */
const ROLE_LABEL_KEYS = new Map<string, I18nKey>([
  ['user', 'export.role.user'],
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
export const roleLabel = (role: string): string => {
  const key = ROLE_LABEL_KEYS.get(role);
  return key ? exportText(key) : role;
};

/** The label a tool call's status carries in the export. */
const STATUS_LABEL_KEYS = new Map<string, I18nKey>([
  ['pending', 'export.toolStatus.pending'],
  ['running', 'export.toolStatus.running'],
  ['completed', 'export.toolStatus.completed'],
  ['error', 'export.toolStatus.error'],
]);

/** The label of a status, when the export knows one. */
export const statusLabel = (status: string): string => {
  const key = STATUS_LABEL_KEYS.get(status);
  return key ? exportText(key) : status;
};

/**
 * The name an agent's messages carry in the export.
 *
 * The agent has a name: the session that ran it recorded it, and the
 * document uses that name rather than a word of its own. A session that
 * recorded none gets a neutral label, because inventing a role would be a
 * claim the history does not support.
 */
export const agentLabel = (agent: string | undefined): string => (
  agent?.trim() || exportText('export.role.assistantFallback')
);

/**
 * The name of a piece of work that ran at the same time as another.
 *
 * Two sub-agents often carry the same title — the runtime names a child
 * after the call that started it — so the agent is what tells them apart. A
 * session that recorded neither keeps what it has.
 */
export const concurrentLabel = (work: ConcurrentWork): string => {
  const agent = work.agent?.trim();
  if (agent && work.title) return `${agent} — ${work.title}`;
  return agent || work.title;
};

/** How much of a long prompt the readable view keeps. */
const MAX_READABLE_PROMPT = 600;

/**
 * A long prompt, cut down to what the readable view shows.
 *
 * The cut is the same in every format: a reader who compares the Markdown
 * and the HTML must not find two different excerpts of the same prompt.
 */
export const readablePrompt = (text: string): string => (
  text.length > MAX_READABLE_PROMPT
    ? `${text.slice(0, MAX_READABLE_PROMPT)}\n\n… [${exportText('export.excerpt')}]`
    : text
);
