import fs from 'node:fs/promises';
import { stat } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import * as z from 'zod/mini';
import type {
  CacheCause,
  CacheEvent,
  DatabaseDiagnostics,
  DiagnosticsResponse,
  LogDiagnostics,
  SourceState,
  StreamEvent,
} from '../shared.js';

const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINES = 100;
const MAX_CACHE_ROWS = 50;
const CONTEXT_DB = path.join('.local', 'share', 'cortexkit', 'magic-context', 'context.db');
const OPENCODE_DB = path.join('.local', 'share', 'opencode', 'opencode.db');
const LOG_PATH = path.join('opencode', 'magic-context', 'magic-context.log');
const MESSAGE_TABLES = ['message', 'session_message'] as const;
const COUNT_TABLES = ['compartments', 'memories', 'pending_ops', 'notes'] as const;
const USAGE_COLUMNS = [
  'last_input_tokens',
  'last_context_percentage',
  'last_usage_percentage',
  'last_usage_context_limit',
] as const;

type SqliteModule = typeof import('node:sqlite');
type OpenCodeCacheEvent = { messageId: string | null; event: CacheEvent };
type OpenCodeCacheEvents = { state: SourceState; lastInputTokens: number | null; events: OpenCodeCacheEvent[] };
type ContextDatabaseResult = { diagnostics: DatabaseDiagnostics['magicContext']; causes: Map<string, CacheCause> };

const sqliteNumberSchema = z.union([
  z.number(),
  z.bigint(),
  z.string().check(z.trim(), z.minLength(1)),
]);
const sqliteStringSchema = z.string().check(z.minLength(1));

export type DataPaths = {
  magicContext: string;
  openCode: string;
  log: string;
};

let sqliteModulePromise: Promise<SqliteModule | null> | null = null;

const loadSqlite = (): Promise<SqliteModule | null> => {
  sqliteModulePromise ??= import('node:sqlite').catch(() => null);
  return sqliteModulePromise;
};

const fileState = (filePath: string): Promise<SourceState> => new Promise((resolve) => {
  stat(filePath, (error) => {
    if (!error) resolve('ready');
    else resolve(error.code === 'ENOENT' ? 'missing' : 'error');
  });
});

export const resolveDataPaths = (home = os.homedir(), temp = os.tmpdir()): DataPaths => ({
  magicContext: path.join(home, CONTEXT_DB),
  openCode: path.join(home, OPENCODE_DB),
  log: path.join(temp, LOG_PATH),
});

const finiteNumber = (value: SQLOutputValue | undefined): number | null => {
  const parsed = sqliteNumberSchema.safeParse(value);
  if (!parsed.success) return null;
  const number = Number(parsed.data);
  return Number.isFinite(number) ? number : null;
};

const stringValue = (value: SQLOutputValue | undefined): string | null => {
  const parsed = sqliteStringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const timestamp = (value: SQLOutputValue | undefined): string | null => {
  const text = sqliteStringSchema.safeParse(value);
  if (text.success) {
    const parsed = Date.parse(text.data);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const number = finiteNumber(value);
  if (number === null) return null;
  const milliseconds = number < 1_000_000_000_000 ? number * 1000 : number;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const ratio = (cacheRead: number | null, inputTokens: number | null): number | null => {
  if (cacheRead === null || inputTokens === null || cacheRead + inputTokens <= 0) return null;
  return Math.max(0, Math.min(1, cacheRead / (cacheRead + inputTokens)));
};

const safeCause = (decision: string | null, reason: string | null, emergency: number | null): CacheCause | null => {
  if (emergency === 1) return 'emergency';
  const normalizedDecision = (decision ?? '').toLowerCase();
  if (normalizedDecision.includes('material')) return 'materialized';
  if (normalizedDecision.includes('threshold')) return 'threshold';
  if (normalizedDecision.includes('compact')) return 'compaction';
  if (normalizedDecision.includes('cache')) return 'cache';
  const combined = (reason ?? '').toLowerCase();
  if (combined.includes('threshold')) return 'threshold';
  if (combined.includes('material')) return 'materialized';
  if (combined.includes('compact')) return 'compaction';
  if (combined.includes('cache')) return 'cache';
  return combined.trim() ? 'unknown' : null;
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const tableNames = (database: DatabaseSyncType): Set<string> => {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all();
  const names = new Set<string>();
  for (const row of rows) {
    const name = stringValue(row.name);
    if (name) names.add(name);
  }
  return names;
};

const tableColumns = (database: DatabaseSyncType, table: string): Set<string> => {
  const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  const names = new Set<string>();
  for (const row of rows) {
    const name = stringValue(row.name);
    if (name) names.add(name);
  }
  return names;
};

const countRows = (database: DatabaseSyncType, table: string, sessionId: string | null): number | null => {
  const columns = tableColumns(database, table);
  if (!columns.size) return null;
  const clauses: string[] = [];
  const parameters: SQLInputValue[] = [];
  if (sessionId && columns.has('session_id')) {
    clauses.push(`${quoteIdentifier('session_id')} = ?`);
    parameters.push(sessionId);
  }
  if (columns.has('deleted_at')) clauses.push(`${quoteIdentifier('deleted_at')} IS NULL`);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const result = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}${where}`).get(...parameters);
  return finiteNumber(result?.count);
};

const usageFromContextDb = (database: DatabaseSyncType, sessionId: string | null): DatabaseDiagnostics['magicContext']['context'] | undefined => {
  if (!sessionId) return undefined;
  const tables = tableNames(database);
  if (!tables.has('session_meta')) return undefined;
  const columns = tableColumns(database, 'session_meta');
  if (!columns.has('session_id')) return undefined;
  const selected = USAGE_COLUMNS.filter((column) => columns.has(column));
  if (!selected.length) return undefined;
  const filters = [`${quoteIdentifier('session_id')} = ?`];
  const parameters: SQLInputValue[] = [sessionId];
  if (columns.has('harness')) {
    filters.push(`${quoteIdentifier('harness')} = ?`);
    parameters.push('opencode');
  }
  const fields = selected.map(quoteIdentifier).join(', ');
  const row = database.prepare(`SELECT ${fields} FROM ${quoteIdentifier('session_meta')} WHERE ${filters.join(' AND ')} LIMIT 1`).get(...parameters);
  if (!row) return undefined;
  const usagePercent = finiteNumber(row.last_context_percentage) ?? finiteNumber(row.last_usage_percentage);
  return {
    inputTokens: finiteNumber(row.last_input_tokens),
    contextLimit: finiteNumber(row.last_usage_context_limit),
    usagePercent: usagePercent === null ? null : Math.max(0, Math.min(100, usagePercent)),
  };
};

const contextDatabase = async (filePath: string, sessionId: string | null, messageIds: string[], sqlite: SqliteModule | null): Promise<ContextDatabaseResult> => {
  if (!sqlite) return { diagnostics: { state: 'unsupported' }, causes: new Map() };
  const pathState = await fileState(filePath);
  if (pathState !== 'ready') return { diagnostics: { state: pathState }, causes: new Map() };
  let database: DatabaseSyncType | null = null;
  try {
    database = new sqlite.DatabaseSync(filePath, { readOnly: true });
    database.exec('PRAGMA query_only = ON');
    const tables = tableNames(database);
    const counts: NonNullable<DatabaseDiagnostics['magicContext']['counts']> = {
      compartments: tables.has('compartments') ? countRows(database, 'compartments', sessionId) : null,
      memories: tables.has('memories') ? countRows(database, 'memories', sessionId) : null,
      pendingOps: tables.has('pending_ops') ? countRows(database, 'pending_ops', sessionId) : null,
      sessionNotes: tables.has('notes') ? countRows(database, 'notes', sessionId) : null,
    };
    const context = usageFromContextDb(database, sessionId);
    const causes = readDecisionCauses(database, sessionId, messageIds);
    const anyTable = COUNT_TABLES.some((table) => tables.has(table)) || tables.has('session_meta');
    const result: DatabaseDiagnostics['magicContext'] = { state: anyTable ? 'ready' : 'partial', counts };
    if (context) result.context = context;
    return { diagnostics: result, causes };
  } catch {
    return { diagnostics: { state: 'error' }, causes: new Map() };
  } finally {
    database?.close();
  }
};

const readDecisionCauses = (database: DatabaseSyncType, sessionId: string | null, messageIds: string[]): Map<string, CacheCause> => {
  if (!sessionId || !messageIds.length || !tableNames(database).has('transform_decisions')) return new Map();
  const columns = tableColumns(database, 'transform_decisions');
  if (!columns.has('session_id') || !columns.has('message_id')) return new Map();
  const selected = ['message_id', 'decision', 'materialize_reason', 'emergency'].filter((column) => columns.has(column));
  if (selected.length < 2) return new Map();
  const filters = [`${quoteIdentifier('session_id')} = ?`];
  const parameters: SQLInputValue[] = [sessionId];
  if (columns.has('harness')) {
    filters.push(`${quoteIdentifier('harness')} = ?`);
    parameters.push('opencode');
  }
  filters.push(`${quoteIdentifier('message_id')} IN (${messageIds.map(() => '?').join(', ')})`);
  parameters.push(...messageIds);
  const rows = database.prepare(
    `SELECT ${selected.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier('transform_decisions')} WHERE ${filters.join(' AND ')} LIMIT ${messageIds.length}`,
  ).all(...parameters);
  const causes = new Map<string, CacheCause>();
  for (const row of rows) {
    const id = stringValue(row.message_id);
    if (!id) continue;
    const cause = safeCause(stringValue(row.decision), stringValue(row.materialize_reason), finiteNumber(row.emergency));
    if (cause) causes.set(id, cause);
  }
  return causes;
};

const openCodeCacheEvents = (database: DatabaseSyncType, sessionId: string | null): OpenCodeCacheEvents => {
  const tables = tableNames(database);
  const table = MESSAGE_TABLES.find((name) => tables.has(name));
  if (!table) return { state: 'partial', lastInputTokens: null, events: [] };
  const columns = tableColumns(database, table);
  const timeColumn = columns.has('time_created') ? 'time_created' : columns.has('created_at') ? 'created_at' : null;
  if (!columns.has('id') || !columns.has('session_id') || !columns.has('data') || !timeColumn) {
    return { state: 'partial', lastInputTokens: null, events: [] };
  }
  const roleExpression = `CASE WHEN json_valid(${quoteIdentifier('data')}) THEN json_extract(${quoteIdentifier('data')}, '$.role') END`;
  const filters = [`${roleExpression} = 'assistant'`];
  const parameters: SQLInputValue[] = [];
  if (sessionId) {
    filters.push(`${quoteIdentifier('session_id')} = ?`);
    parameters.push(sessionId);
  }
  const rows = database.prepare(`
    SELECT ${quoteIdentifier('id')} AS message_id, ${quoteIdentifier(timeColumn)} AS created_at,
      json_extract(${quoteIdentifier('data')}, '$.role') AS role,
      json_extract(${quoteIdentifier('data')}, '$.tokens.input') AS input_tokens,
      json_extract(${quoteIdentifier('data')}, '$.tokens.cache.read') AS cache_read,
      json_extract(${quoteIdentifier('data')}, '$.tokens.cache.write') AS cache_write,
      json_extract(${quoteIdentifier('data')}, '$.tokens.total') AS total_tokens
    FROM ${quoteIdentifier(table)} WHERE ${filters.join(' AND ')}
    ORDER BY ${quoteIdentifier(timeColumn)} DESC LIMIT ${MAX_CACHE_ROWS}
  `).all(...parameters);
  const events: OpenCodeCacheEvent[] = [];
  for (const row of rows) {
    if (stringValue(row.role) !== 'assistant') continue;
    const inputTokens = finiteNumber(row.input_tokens);
    const cacheRead = finiteNumber(row.cache_read);
    const cacheWrite = finiteNumber(row.cache_write);
    const totalTokens = finiteNumber(row.total_tokens) ?? [inputTokens, cacheRead, cacheWrite]
      .reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (totalTokens <= 0) continue;
    const messageId = stringValue(row.message_id);
    events.push({
      messageId,
      event: {
        at: timestamp(row.created_at),
        inputTokens,
        cacheRead,
        cacheWrite,
        totalTokens,
        hitRatio: ratio(cacheRead, inputTokens),
        cause: null,
      },
    });
  }
  return { state: 'ready', lastInputTokens: events[0]?.event.inputTokens ?? null, events };
};

const openCodeDatabase = async (filePath: string, sessionId: string | null, sqlite: SqliteModule | null): Promise<OpenCodeCacheEvents> => {
  if (!sqlite) return { state: 'unsupported', lastInputTokens: null, events: [] };
  const pathState = await fileState(filePath);
  if (pathState !== 'ready') return { state: pathState, lastInputTokens: null, events: [] };
  let database: DatabaseSyncType | null = null;
  try {
    database = new sqlite.DatabaseSync(filePath, { readOnly: true });
    database.exec('PRAGMA query_only = ON');
    return openCodeCacheEvents(database, sessionId);
  } catch {
    return { state: 'error', lastInputTokens: null, events: [] };
  } finally {
    database?.close();
  }
};

const logCategory = (message: string): StreamEvent['category'] | null => {
  const lower = message.toLowerCase();
  if (lower.includes('dreamer')) return 'dreamer';
  if (lower.includes('historian') || lower.includes('compart')) return 'historian';
  if (lower.includes('transform') || lower.includes('material')) return 'transform';
  if (lower.includes('cache') || lower.includes('tokens.input')) return 'cache';
  if (lower.includes('session.status') || lower.includes('stream') || lower.includes('receive')
    || lower.includes('complete') || lower.includes('event')) return 'stream';
  return null;
};

const parsedTime = (value: string | undefined): string | null => {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

export const parseMagicContextLogLine = (line: string): StreamEvent | null => {
  const legacy = line.match(/^\[([^\]]+)\]\s*\[magic-context\](?:\[[^\]]+\])?\s*(.*)$/i);
  const fleet = line.match(/^(\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*)$/i);
  const time = legacy?.[1] ?? fleet?.[1];
  const message = legacy?.[2] ?? fleet?.[3];
  if (!message) return null;
  const category = logCategory(message);
  if (!category) return null;
  const numberIn = (name: string): number | null => {
    const match = message.match(new RegExp(`(?:${name})\\s*[=: ]\\s*(\\d+)`, 'i'));
    return match ? Number(match[1]) : null;
  };
  const level = fleet?.[2]?.toLowerCase();
  const normalizedLevel: StreamEvent['level'] = level === 'trace' || level === 'debug' || level === 'warn' || level === 'error'
    ? level
    : 'info';
  return {
    at: parsedTime(time),
    level: normalizedLevel,
    category,
    inputTokens: numberIn('tokens(?:\\.input| input)'),
    cacheRead: numberIn('cache(?:\\.read| read)'),
    cacheWrite: numberIn('cache(?:\\.write| write)'),
  };
};

const readLog = async (filePath: string): Promise<LogDiagnostics> => {
  const observedAt = new Date().toISOString();
  const pathState = await fileState(filePath);
  if (pathState !== 'ready') return { state: pathState, observedAt, events: [] };
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const info = await handle.stat();
    const byteLength = Math.min(info.size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(byteLength);
    if (byteLength) await handle.read(buffer, 0, byteLength, info.size - byteLength);
    const lines = buffer.toString('utf8').split(/\r?\n/).slice(-MAX_LOG_LINES);
    const events = lines.flatMap((line) => {
      const event = parseMagicContextLogLine(line);
      return event ? [event] : [];
    });
    return { state: 'ready', observedAt, events };
  } catch {
    return { state: 'error', observedAt, events: [] };
  } finally {
    await handle?.close();
  }
};

export const readDiagnostics = async ({
  sessionId,
  includeDatabase,
  paths = resolveDataPaths(),
}: {
  sessionId: string | null;
  includeDatabase: boolean;
  paths?: DataPaths;
}): Promise<DiagnosticsResponse> => {
  const log = await readLog(paths.log);
  const response: DiagnosticsResponse = { schemaVersion: 1, observedAt: new Date().toISOString(), log };
  if (includeDatabase) {
    const sqlite = await loadSqlite();
    const openCode = await openCodeDatabase(paths.openCode, sessionId, sqlite);
    const messageIds = openCode.events.flatMap(({ messageId }) => messageId ? [messageId] : []);
    const context = await contextDatabase(paths.magicContext, sessionId, messageIds, sqlite);
    response.database = {
      observedAt: response.observedAt,
      magicContext: context.diagnostics,
      openCode: {
        state: openCode.state,
        lastInputTokens: openCode.lastInputTokens,
        cacheEvents: openCode.events.map(({ messageId, event }) => ({
          ...event,
          cause: messageId ? context.causes.get(messageId) ?? null : null,
        })),
      },
    };
  }
  return response;
};
