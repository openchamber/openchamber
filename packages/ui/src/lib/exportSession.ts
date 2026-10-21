/**
 * The session export's public surface.
 *
 * The export itself lives in `./export/`: one pipeline that collects the
 * sessions, normalizes their records into events, resolves the subagent
 * relationships, orders the result and projects it into a view. This module
 * keeps the API the rest of the app uses and the parts that touch the
 * platform — the download, the desktop save dialog, the file name.
 *
 * The Markdown the app used to write is still written from the same messages,
 * with the same model names and the same context handling. What changed is
 * that the document is built from the shared pipeline, so the Header export
 * and the Sidebar export now mean the same thing.
 */

import { z } from 'zod';
import type { Message, Part } from '@/lib/opencode/model';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime, openDesktopPath, revealDesktopPath, saveDesktopMarkdownFile, type DesktopSaveFileFormat } from '@/lib/desktop';
import { getRevealLabelKey } from '@/lib/utils';
import { formatMessageText } from '@/lib/messages/messageMarkdown';
import { readTextField } from '@/lib/export/values';
import { readInvocationChildSessionID } from '@/lib/export/childSession';
import { buildExportFromRecords, type ExportPipelineResult } from '@/lib/export/pipeline';
import type { ExportSession } from '@/lib/export/collect';
import { renderExportHtml } from '@/lib/export/html';
import { renderExportJson } from '@/lib/export/json';
import { renderExportMarkdown } from '@/lib/export/markdown';
import type { ProjectionMode } from '@/lib/export/project';

export type SessionMessageRecord = { info: Message; parts: Part[] };

/**
 * A child session as the export takes it.
 *
 * The session's id is what joins the child to the call that started it, so a
 * caller that knows it should pass it. A caller that does not still gets a
 * readable export: the child is matched to its call by the description the
 * call recorded.
 */
type ChildSessionExport = {
  /** The child's session id, when the caller knows it. */
  id?: string;
  title: string;
  agent?: string;
  records: SessionMessageRecord[];
  children: ChildSessionExport[];
};

/** The formats an export can be written in. */
export type ExportFormat = 'markdown' | 'html' | 'json';

/**
 * A message's text the way the Markdown export renders it. Guest message and
 * session items carry the same text, so an extension sees what the export
 * file would.
 */
export function formatMessageRecordText(record: SessionMessageRecord): string {
  return formatMessageText(record.parts, { user: record.info.role === 'user' });
}

type ExportSessionSource = {
  /** The session the user asked to export. */
  root: ExportSession;
  /** Every session the client knows, active and archived. */
  sessions: readonly ExportSession[];
  /** The records of the sessions the export covers, keyed by session id. */
  records: ReadonlyMap<string, SessionMessageRecord[]>;
};

/**
 * Builds the export and renders it in the requested format.
 */
export const buildExportDocument = (
  source: ExportSessionSource,
  format: ExportFormat,
  mode: ProjectionMode,
): string => {
  const result = buildExportFromRecords({
    root: source.root,
    sessions: source.sessions,
    records: source.records,
  }, mode);

  return renderExportDocument(result, format, mode, source.root.title);
};

/**
 * Renders the export the pipeline produced, in the requested format.
 *
 * The pipeline's result is the one history: the three renderers read the same
 * events, so they cannot disagree about what happened.
 */
export const renderExportDocument = (
  result: ExportPipelineResult,
  format: ExportFormat,
  mode: ProjectionMode,
  sessionTitle?: string | null,
): string => {
  const { projection, timeline } = result;
  const title = sessionTitle?.trim() || 'Session';
  const sessionCount = timeline.sessions.size;

  if (format === 'json') {
    return renderExportJson(timeline);
  }
  if (format === 'html') {
    return renderExportHtml(projection, { title, mode, findings: timeline.findings, sessionCount });
  }
  return renderExportMarkdown(projection, { title, mode, findings: timeline.findings, sessionCount });
};

/**
 * The Markdown export of one session and its subagents.
 *
 * The caller passes the root's records and the child sessions below it. The
 * child sessions are joined to the root's calls by their session id, or by
 * the description the call recorded when the id is not known.
 */
export const formatSessionAsMarkdown = (
  messages: SessionMessageRecord[],
  sessionTitle?: string | null,
  childSessions?: ChildSessionExport[],
  options: {
    /** The root session's id, used to order the subagents against the parent. */
    rootSessionID?: string;
    /** The mode the document is written in. */
    mode?: ProjectionMode;
  } = {},
): string => {
  const rootID = options.rootSessionID ?? 'root';
  const children = childSessions ?? [];

  const records = new Map<string, SessionMessageRecord[]>();
  const sessions: ExportSession[] = [{
    id: rootID,
    title: sessionTitle?.trim() || 'Session',
  }];

  // A child without a session id is joined to the call that recorded its
  // description. The call names the child session it started, so the child
  // takes that id and the pipeline ties the two together by it. A call that
  // named no session at all leaves the child its own id, and the call's id
  // is what ties the two together.
  const usedCallIDs = new Set<string>();
  let counter = 0;
  const visit = (nodes: ChildSessionExport[], parentID: string): void => {
    for (const child of nodes) {
      counter += 1;
      const call = child.id ? undefined : matchCallByDescription(messages, child, usedCallIDs);
      const invocationKey = call && !call.childSessionID ? call.callID : undefined;
      const id = child.id ?? call?.childSessionID ?? invocationKey ?? `child-${counter}`;
      records.set(id, child.records);
      sessions.push({
        id,
        parentID,
        title: child.title,
        agent: child.agent,
        invocationKey,
      });
      visit(child.children, id);
    }
  };
  visit(children, rootID);
  records.set(rootID, messages);

  return buildExportDocument({
    root: sessions[0],
    sessions,
    records,
  }, 'markdown', options.mode ?? 'readable');
};

/**
 * The call that recorded the child's description, and the child session it
 * names.
 *
 * The description is the only identity a child without a session id has, so
 * the call that wrote the same description is the one that started it. A
 * call that was already taken by another child is not a candidate.
 */
const matchCallByDescription = (
  messages: SessionMessageRecord[],
  child: ChildSessionExport,
  usedCallIDs: Set<string>,
): { callID: string; childSessionID?: string } | undefined => {
  const description = child.title.trim();
  if (!description) return undefined;
  for (const record of messages) {
    for (const part of record.parts) {
      if (part.type !== 'tool') continue;
      if (usedCallIDs.has(part.callID)) continue;
      const callDescription = readTextField(part.state.input.description);
      if (callDescription !== description) continue;
      usedCallIDs.add(part.callID);
      return {
        callID: part.callID,
        childSessionID: readInvocationChildSessionID(part),
      };
    }
  }
  return undefined;
};

/** Downloads any exported text under the name the caller chose. */
export function downloadAsText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * The answer the VS Code bridge gives after a save.
 *
 * The bridge answers with whatever it has, so the answer is parsed at the
 * call site and a malformed one is treated as no answer.
 */
const saveResultSchema = z.object({
  saved: z.boolean().optional(),
  path: z.string().optional(),
});

/**
 * The file type the save dialog offers for each export format.
 *
 * The dialog must name the type of file that is actually being written: a
 * document saved as HTML is not a Markdown file, and the dialog that says
 * otherwise misleads the person saving it.
 */
const SAVE_FORMATS = new Map<ExportFormat, DesktopSaveFileFormat>([
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['json', 'json'],
]);

export async function saveAsMarkdownDesktop(
  content: string,
  filename: string,
  format: ExportFormat = 'markdown',
): Promise<string | null> {
  const desktopPath = await saveDesktopMarkdownFile(filename, content, SAVE_FORMATS.get(format) ?? 'markdown');
  if (desktopPath) {
    return desktopPath;
  }

  if (!isVSCodeRuntime()) {
    return null;
  }

  try {
    const answer = await getRegisteredRuntimeAPIs()?.vscode?.saveMarkdown?.({
      fileName: filename,
      content,
      format: SAVE_FORMATS.get(format) ?? 'markdown',
    });
    const payload = saveResultSchema.safeParse(answer);
    if (!payload.success || payload.data.saved !== true) {
      return null;
    }

    return readTextField(payload.data.path) ?? null;
  } catch {
    return null;
  }
}

export async function revealExportedMarkdown(path: string): Promise<boolean> {
  const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
  if (runtimeFiles?.revealPath) {
    try {
      const result = await runtimeFiles.revealPath(path);
      return Boolean(result?.success);
    } catch {
      return false;
    }
  }

  if (await revealDesktopPath(path)) {
    return true;
  }

  return openDesktopPath(path);
}

export function getExportRevealLabelKey() {
  return getRevealLabelKey();
}

export function buildExportFilename(sessionTitle?: string | null, extension = 'md'): string {
  const base = sessionTitle?.trim() || 'session';
  const safe = base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const normalizedBase = safe || 'session';
  const date = new Date().toISOString().split('T')[0];
  return `${normalizedBase}-${date}.${extension}`;
}
