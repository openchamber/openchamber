/**
 * The export pipeline.
 *
 * One path builds every format: collect the sessions, normalize their records
 * into events, resolve the relationships between a call and the child
 * session it started, order the result, and project it into the view the
 * format asks for. The Markdown, HTML and JSON renderers only read what
 * comes out of here, so they cannot disagree about the history.
 */

import {
  collectExportSessions,
  collectLoadedSessions,
  type ExportRecordLoader,
  type ExportSession,
  type ExportSourceRecord,
} from './collect';
import { normalizeExportTimeline } from './normalize';
import { buildExportTree } from './order';
import { projectExport, readRootAgent, type ProjectionMode } from './project';
import type { ExportTimeline } from './events';

type ExportPipelineInput = {
  /** The session the user asked to export. */
  root: ExportSession;
  /** Every session the client knows, active and archived. */
  sessions: readonly ExportSession[];
  /** Loads one session's records; null when the session is gone. */
  load: ExportRecordLoader;
  /**
   * Whether the export covers the sub-agent sessions.
   *
   * A caller that left the sub-agent transcripts out on purpose does not
   * want the export to report them as missing.
   */
  includeSubagents?: boolean;
};

/** The export built from sessions whose records the caller already holds. */
type LoadedExportPipelineInput = {
  root: ExportSession;
  sessions: readonly ExportSession[];
  /** The records of the sessions the caller holds, keyed by session id. */
  records: ReadonlyMap<string, ExportSourceRecord[]>;
  /** Whether the export covers the sub-agent sessions. */
  includeSubagents?: boolean;
};

export type ExportPipelineResult = {
  /** The normalized, ordered events. */
  timeline: ExportTimeline;
  /** The ordered spine, with the subagent's blocks in place. */
  tree: ReturnType<typeof buildExportTree>;
  /** The export's view of the history, in the requested mode. */
  projection: ReturnType<typeof projectExport>;
  /**
   * The agent the exported session ran.
   *
   * The document names the agent in the root's own messages instead of a
   * role of its own: the agent has a name, and the reader knows it.
   */
  rootAgent?: string;
};

/** Normalizes, orders and projects the collected sessions. */
const buildFromCollection = (
  collection: ReturnType<typeof collectLoadedSessions>,
  rootSessionID: string,
  mode: ProjectionMode,
  includeSubagents: boolean,
): ExportPipelineResult => {
  const { timeline } = normalizeExportTimeline({
    rootSessionID,
    sessions: collection.sessions,
    missing: collection.missing,
    findings: collection.findings,
    includeSubagents,
  });

  const tree = buildExportTree(timeline);
  const projection = projectExport(tree, mode);

  return { timeline, tree, projection, rootAgent: readRootAgent(timeline) };
};

/**
 * Runs the pipeline over sessions whose records the caller already holds.
 */
export const buildExportFromRecords = (
  input: LoadedExportPipelineInput,
  mode: ProjectionMode,
): ExportPipelineResult => {
  const collection = collectLoadedSessions({
    root: input.root,
    sessions: input.sessions,
    records: input.records,
  });
  return buildFromCollection(collection, input.root.id, mode, input.includeSubagents ?? true);
};

/**
 * Runs the pipeline, loading the descendants the caller did not hold.
 */
export const buildExport = async (
  input: ExportPipelineInput,
  mode: ProjectionMode,
): Promise<ExportPipelineResult> => {
  const collection = await collectExportSessions({
    root: input.root,
    sessions: input.sessions,
    load: input.load,
  });
  return buildFromCollection(collection, input.root.id, mode, input.includeSubagents ?? true);
};
