/**
 * The JSON renderer.
 *
 * The JSON export is the audit copy: it carries the source records as they
 * were recorded, the events the pipeline derived from them, and the
 * relationships between a call and the child session it started. A reader can
 * rebuild the conversation from it, or check the derived view against the
 * original.
 *
 * The two kinds of data stay apart on purpose: `source` holds what the
 * runtime recorded, `events` holds what the export derived. Nothing is
 * dropped — a part the pipeline does not know is still in `source`.
 */

import type { Message, Part } from '@/lib/opencode/model';
import type { ExportEvent, ExportFinding, ExportSessionInfo, ExportTimeline } from './events';
import { orderByRecordedTime } from './ordering';
import { exportText, findingText } from './i18n';

/**
 * The schema and ordering guarantees the JSON export documents.
 *
 * The wording is the reader's language, so the schema is built when the
 * document is written rather than when this module is loaded.
 */
const jsonExportSchema = () => ({
  version: 1,
  description: exportText('export.json.schema.description'),
  ordering: exportText('export.json.ordering'),
  fields: {
    'rootSessionID': exportText('export.json.schema.rootSessionID'),
    'sessions': exportText('export.json.schema.sessions'),
    'events': exportText('export.json.schema.events'),
    'source': exportText('export.json.schema.source'),
    'findings': exportText('export.json.schema.findings'),
  },
});

/** One session's records, as the JSON export carries them. */
type ExportJsonSession = {
  sessionID: string;
  title: string;
  agent?: string;
  parentID?: string;
  records: Array<{ info: Message; parts: Part[] }>;
};

/** The JSON export, as the document the reader inspects. */
type ExportJson = {
  schema: ReturnType<typeof jsonExportSchema>;
  rootSessionID: string;
  sessions: Record<string, ExportSessionInfo>;
  events: ExportEvent[];
  source: Record<string, ExportJsonSession>;
  findings: ExportJsonFinding[];
};

/**
 * A finding, as the JSON export carries it.
 *
 * The finding keeps the key of its text and the values that text names, and
 * the text itself in the reader's language. A tool that reads the export
 * gets a sentence, not a key it has to resolve itself.
 */
type ExportJsonFinding = ExportFinding & {
  detail: string;
};

/**
 * The events in the order the schema promises.
 *
 * The pipeline collects the events session by session, so the raw list is
 * grouped by session. The schema says the events are ordered by their
 * recorded timestamp, so the list is sorted here: by the timestamp, then by
 * the order the source recorded the event, then by the session it belongs to.
 * An event without a timestamp keeps the place the source gave it, and the
 * source order breaks ties.
 */
const orderedEvents = (events: readonly ExportEvent[]): ExportEvent[] => orderByRecordedTime(
  events.map((event) => ({
    event,
    timestamp: event.timestamp,
    sourceOrder: event.origin.sourceOrder,
    sessionID: event.sessionID,
  })),
).map((entry) => entry.event);

/** The JSON export, as a plain object. */
const buildExportJson = (timeline: ExportTimeline): ExportJson => ({
  schema: jsonExportSchema(),
  rootSessionID: timeline.rootSessionID,
  sessions: Object.fromEntries(
    [...timeline.sessions.values()].map((session) => [session.id, session]),
  ),
  events: orderedEvents(timeline.events),
  source: Object.fromEntries(
    [...timeline.sourceRecords.values()].map((session) => [
      session.sessionID,
      {
        sessionID: session.sessionID,
        title: session.title,
        agent: session.agent,
        parentID: session.parentID,
        records: session.records,
      },
    ]),
  ),
  findings: timeline.findings.map((finding) => ({
    ...finding,
    detail: findingText(finding.messageKey, finding.messageParams),
  })),
});

/** The JSON export, as text. */
export const renderExportJson = (timeline: ExportTimeline): string => (
  `${JSON.stringify(buildExportJson(timeline), null, 2)}\n`
);
