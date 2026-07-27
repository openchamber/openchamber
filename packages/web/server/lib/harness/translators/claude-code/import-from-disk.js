/**
 * List and import Claude Code projects/sessions from local disk.
 *
 * Claude stores transcripts under `$CLAUDE_CONFIG_DIR/projects` (or
 * `~/.claude/projects`) as `<encoded-cwd>/<session-id>.jsonl`. Encoding
 * replaces non-alphanumeric path characters with `-` (ambiguous to reverse),
 * so cwd is taken from JSONL metadata when present.
 *
 * Import creates OpenCode session shells + harness bindings with
 * `foreignSessionId` for Claude resume. JSONL is not replayed into OpenCode
 * message stores (format is unstable / Anthropic-internal).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import {
  bindSession,
  flushSessionBindings,
  listSessionBindings,
} from '../../session-bindings.js';
import { getHarnessCapabilities } from '../../registry.js';

const MAX_IMPORT_BATCH = 100;
const MAX_JSONL_SCAN_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 120;
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {string} [homeDir]
 * @returns {string[]}
 */
export function listClaudeConfigDirCandidates(env = process.env, homeDir = os.homedir()) {
  const candidates = [];
  const configDir = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (configDir) {
    candidates.push(configDir);
  }
  if (typeof homeDir === 'string' && homeDir.trim()) {
    candidates.push(path.join(homeDir, '.claude'));
    candidates.push(path.join(homeDir, '.config', 'claude'));
  }
  return candidates;
}

/**
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [options.env]
 * @param {string} [options.homeDir]
 * @returns {string | null}
 */
export function resolveClaudeProjectsRoot(options = {}) {
  const fsLike = options.fs || fs;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  for (const configDir of listClaudeConfigDirCandidates(env, homeDir)) {
    const projectsRoot = path.join(configDir, 'projects');
    try {
      if (fsLike.existsSync(projectsRoot) && fsLike.statSync(projectsRoot).isDirectory()) {
        return projectsRoot;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Best-effort decode of Claude's encoded project folder name.
 * Prefer JSONL `cwd` over this when available.
 *
 * @param {string} encoded
 * @returns {string | null}
 */
export function decodeClaudeProjectKey(encoded) {
  if (typeof encoded !== 'string' || !encoded.trim()) return null;
  const key = encoded.trim();
  // Claude replaces non-alphanumeric with `-`. Leading `-` usually means an
  // absolute POSIX path (`/Users/...` → `-Users-...`).
  if (key.startsWith('-')) {
    return `/${key.slice(1).replace(/-/g, '/')}`;
  }
  // Windows drive: `C-Users-...` → `C:/Users/...`
  if (/^[A-Za-z]-/.test(key)) {
    return `${key[0]}:/${key.slice(2).replace(/-/g, '/')}`;
  }
  return key.replace(/-/g, '/');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function extractTextContent(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  const parts = [];
  for (const block of value) {
    if (!block || typeof block !== 'object') continue;
    const type = /** @type {{ type?: unknown, text?: unknown }} */ (block).type;
    const text = /** @type {{ text?: unknown }} */ (block).text;
    if (type === 'text' && typeof text === 'string' && text.trim()) {
      parts.push(text.trim());
    }
  }
  return parts.join('\n').trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateTitle(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Scan the start of a Claude JSONL transcript for title + cwd metadata.
 * Never throws for malformed lines — skips and continues.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @returns {{ title: string | null, directory: string | null, updatedAt: number | null }}
 */
export function inspectClaudeSessionJsonl(filePath, options = {}) {
  const fsLike = options.fs || fs;
  let title = null;
  let directory = null;
  let updatedAt = null;

  try {
    const fd = fsLike.openSync(filePath, 'r');
    try {
      const stat = fsLike.fstatSync(fd);
      if (Number.isFinite(stat.mtimeMs)) {
        updatedAt = Math.round(stat.mtimeMs);
      }
      const size = Math.min(Math.max(0, Number(stat.size) || 0), MAX_JSONL_SCAN_BYTES);
      if (size === 0) {
        return { title, directory, updatedAt };
      }
      const buffer = Buffer.alloc(size);
      fsLike.readSync(fd, buffer, 0, size, 0);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let record;
        try {
          record = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!record || typeof record !== 'object') continue;

        if (!directory && typeof record.cwd === 'string' && record.cwd.trim()) {
          directory = record.cwd.trim();
        }

        const type = typeof record.type === 'string' ? record.type : '';
        if (!title && type === 'summary' && typeof record.summary === 'string' && record.summary.trim()) {
          title = truncateTitle(record.summary);
        }
        if (!title) {
          const customName = typeof record.customTitle === 'string'
            ? record.customTitle
            : typeof record.sessionName === 'string'
              ? record.sessionName
              : typeof record.name === 'string' && type === 'session-meta'
                ? record.name
                : null;
          if (customName && customName.trim()) {
            title = truncateTitle(customName);
          }
        }
        if (!title && (type === 'user' || record?.message?.role === 'user')) {
          const content = record?.message?.content ?? record?.content;
          const textContent = extractTextContent(content);
          // Skip tool_result-only user turns.
          if (textContent && !textContent.startsWith('<') && textContent.length > 0) {
            title = truncateTitle(textContent);
          }
        }

        if (title && directory) break;
      }
    } finally {
      fsLike.closeSync(fd);
    }
  } catch {
    // unreadable file — return whatever we have
  }

  return { title, directory, updatedAt };
}

/**
 * @param {string} projectsRoot
 * @param {string} projectKey
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @returns {Array<{ foreignSessionId: string, jsonlPath: string, title: string | null, directory: string | null, updatedAt: number | null }>}
 */
export function listClaudeSessionsInProject(projectsRoot, projectKey, options = {}) {
  const fsLike = options.fs || fs;
  const projectDir = path.join(projectsRoot, projectKey);
  /** @type {string[]} */
  const sessionFiles = [];

  const collectJsonl = (dirPath) => {
    let entries;
    try {
      entries = fsLike.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith('.jsonl')) continue;
      // Skip subagent / sidechain agent transcripts.
      if (name.startsWith('agent-')) continue;
      const base = name.slice(0, -'.jsonl'.length);
      if (!SESSION_UUID_RE.test(base)) continue;
      sessionFiles.push(path.join(dirPath, name));
    }
  };

  collectJsonl(projectDir);
  collectJsonl(path.join(projectDir, 'sessions'));

  const decodedFallback = decodeClaudeProjectKey(projectKey);
  const sessions = sessionFiles.map((jsonlPath) => {
    const foreignSessionId = path.basename(jsonlPath, '.jsonl');
    const meta = inspectClaudeSessionJsonl(jsonlPath, { fs: fsLike });
    return {
      foreignSessionId,
      jsonlPath,
      title: meta.title,
      directory: meta.directory || decodedFallback,
      updatedAt: meta.updatedAt,
    };
  });

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

/**
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [options.env]
 * @param {string} [options.homeDir]
 * @param {() => object[]} [options.listBindings]
 * @param {(directory: string) => boolean | Promise<boolean>} [options.directoryExists]
 * @returns {Promise<{ configDir: string | null, projectsRoot: string | null, projects: object[] }>}
 */
export async function listClaudeImportCandidates(options = {}) {
  const fsLike = options.fs || fs;
  const listBindings = options.listBindings || listSessionBindings;
  const projectsRoot = resolveClaudeProjectsRoot({
    fs: fsLike,
    env: options.env,
    homeDir: options.homeDir,
  });

  if (!projectsRoot) {
    return { configDir: null, projectsRoot: null, projects: [] };
  }

  const configDir = path.dirname(projectsRoot);
  const boundForeignIds = new Set(
    listBindings()
      .map((binding) => (typeof binding?.foreignSessionId === 'string' ? binding.foreignSessionId : ''))
      .filter(Boolean),
  );

  let projectKeys = [];
  try {
    projectKeys = fsLike.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const err = new Error(error?.message || 'Failed to read Claude projects directory');
    err.code = 'CLAUDE_PROJECTS_UNREADABLE';
    err.statusCode = 500;
    throw err;
  }

  const directoryExists = options.directoryExists || ((directory) => {
    try {
      return fsLike.existsSync(directory) && fsLike.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });

  const projects = [];
  for (const projectKey of projectKeys) {
    const sessionsRaw = listClaudeSessionsInProject(projectsRoot, projectKey, { fs: fsLike });
    if (sessionsRaw.length === 0) continue;

    // Prefer the most common cwd among sessions for the project directory.
    /** @type {Map<string, number>} */
    const cwdCounts = new Map();
    for (const session of sessionsRaw) {
      if (!session.directory) continue;
      cwdCounts.set(session.directory, (cwdCounts.get(session.directory) || 0) + 1);
    }
    let directory = decodeClaudeProjectKey(projectKey);
    let bestCount = 0;
    for (const [cwd, count] of cwdCounts) {
      if (count > bestCount) {
        bestCount = count;
        directory = cwd;
      }
    }

    const resolvedSessions = [];
    for (const session of sessionsRaw) {
      const sessionDirectory = session.directory || directory;
      const missing = sessionDirectory ? !(await directoryExists(sessionDirectory)) : true;
      resolvedSessions.push({
        foreignSessionId: session.foreignSessionId,
        title: session.title,
        directory: sessionDirectory,
        updatedAt: session.updatedAt,
        alreadyImported: boundForeignIds.has(session.foreignSessionId),
        directoryMissing: missing,
      });
    }

    projects.push({
      projectKey,
      directory,
      directoryMissing: directory ? !(await directoryExists(directory)) : true,
      sessionCount: resolvedSessions.length,
      sessions: resolvedSessions,
    });
  }

  projects.sort((a, b) => {
    const aTime = Math.max(0, ...a.sessions.map((s) => s.updatedAt || 0));
    const bTime = Math.max(0, ...b.sessions.map((s) => s.updatedAt || 0));
    return bTime - aTime;
  });

  return { configDir, projectsRoot, projects };
}

/**
 * @param {object} params
 * @param {Array<{ foreignSessionId: string, directory: string, title?: string | null }>} params.sessions
 * @param {(directory: string, title?: string | null) => Promise<string>} params.createSession
 * @param {typeof bindSession} [params.bind]
 * @param {typeof flushSessionBindings} [params.flush]
 * @param {() => object[]} [params.listBindings]
 * @param {(directory: string) => boolean | Promise<boolean>} [params.directoryExists]
 * @param {string} [params.defaultModelRef]
 * @returns {Promise<{ results: object[], summary: { imported: number, skipped: number, failed: number } }>}
 */
export async function importClaudeSessions(params) {
  const sessions = Array.isArray(params.sessions) ? params.sessions : [];
  if (sessions.length === 0) {
    return { results: [], summary: { imported: 0, skipped: 0, failed: 0 } };
  }
  if (sessions.length > MAX_IMPORT_BATCH) {
    const error = new Error(`Import is limited to ${MAX_IMPORT_BATCH} sessions per request`);
    error.code = 'IMPORT_BATCH_TOO_LARGE';
    error.statusCode = 400;
    throw error;
  }

  const createSession = params.createSession;
  if (typeof createSession !== 'function') {
    const error = new Error('createSession is required');
    error.code = 'IMPORT_MISCONFIGURED';
    error.statusCode = 500;
    throw error;
  }

  const bind = params.bind || bindSession;
  const flush = params.flush || flushSessionBindings;
  const listBindings = params.listBindings || listSessionBindings;
  const directoryExists = params.directoryExists || ((directory) => {
    try {
      return fs.existsSync(directory) && fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
  const defaultModelRef = typeof params.defaultModelRef === 'string' && params.defaultModelRef.trim()
    ? params.defaultModelRef.trim()
    : 'sonnet';

  const boundForeignIds = new Map();
  for (const binding of listBindings()) {
    if (typeof binding?.foreignSessionId === 'string' && binding.foreignSessionId) {
      boundForeignIds.set(binding.foreignSessionId, binding.sessionId);
    }
  }

  const capabilitySnapshot = getHarnessCapabilities('claude-code') || null;
  /** @type {object[]} */
  const results = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of sessions) {
    const foreignSessionId = typeof item?.foreignSessionId === 'string' ? item.foreignSessionId.trim() : '';
    const directory = typeof item?.directory === 'string' ? item.directory.trim() : '';
    const title = typeof item?.title === 'string' && item.title.trim()
      ? truncateTitle(item.title.trim())
      : null;

    if (!foreignSessionId || !SESSION_UUID_RE.test(foreignSessionId)) {
      failed += 1;
      results.push({
        ok: false,
        foreignSessionId: foreignSessionId || null,
        directory: directory || null,
        error: 'foreignSessionId must be a Claude session UUID',
        code: 'SESSION_ID_INVALID',
      });
      continue;
    }

    if (!directory) {
      failed += 1;
      results.push({
        ok: false,
        foreignSessionId,
        directory: null,
        error: 'directory is required',
        code: 'DIRECTORY_REQUIRED',
      });
      continue;
    }

    if (boundForeignIds.has(foreignSessionId)) {
      skipped += 1;
      results.push({
        ok: true,
        foreignSessionId,
        sessionId: boundForeignIds.get(foreignSessionId),
        directory,
        status: 'skipped',
        reason: 'already-bound',
      });
      continue;
    }

    if (!(await directoryExists(directory))) {
      failed += 1;
      results.push({
        ok: false,
        foreignSessionId,
        directory,
        error: 'Project directory does not exist on this host',
        code: 'DIRECTORY_MISSING',
      });
      continue;
    }

    let sessionId;
    try {
      sessionId = await createSession(directory, title);
    } catch (error) {
      failed += 1;
      results.push({
        ok: false,
        foreignSessionId,
        directory,
        error: error?.message || 'Failed to create OpenCode session',
        code: error?.code || 'SESSION_CREATE_FAILED',
      });
      continue;
    }

    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      failed += 1;
      results.push({
        ok: false,
        foreignSessionId,
        directory,
        error: 'OpenCode session create returned no id',
        code: 'SESSION_CREATE_FAILED',
      });
      continue;
    }

    try {
      const { binding, conflict } = bind({
        sessionId: sessionId.trim(),
        harnessId: 'claude-code',
        directory,
        target: { harnessId: 'claude-code', modelRef: defaultModelRef },
        foreignSessionId,
        capabilitySnapshot,
      });
      if (conflict) {
        failed += 1;
        results.push({
          ok: false,
          foreignSessionId,
          sessionId: sessionId.trim(),
          directory,
          error: 'Session already bound to a different engine',
          code: 'BINDING_CONFLICT',
        });
        continue;
      }
      boundForeignIds.set(foreignSessionId, binding.sessionId);
      imported += 1;
      results.push({
        ok: true,
        foreignSessionId,
        sessionId: binding.sessionId,
        directory,
        title,
        status: 'imported',
      });
    } catch (error) {
      failed += 1;
      results.push({
        ok: false,
        foreignSessionId,
        sessionId: sessionId.trim(),
        directory,
        error: error?.message || 'Failed to bind Claude session',
        code: error?.code || 'BINDING_FAILED',
      });
    }
  }

  try {
    flush();
  } catch {
    // binding flush failure must not hide per-item results
  }

  return {
    results,
    summary: { imported, skipped, failed },
  };
}

/**
 * Build an OpenCode session creator using the harness OpenCode URL helpers.
 *
 * @param {object} deps
 * @param {(path: string, directory?: string) => string} deps.buildOpenCodeUrl
 * @param {() => Record<string, string>} [deps.getOpenCodeAuthHeaders]
 * @param {typeof createOpencodeClient} [deps.createClient]
 * @returns {(directory: string, title?: string | null) => Promise<string>}
 */
export function createOpenCodeSessionFactory(deps) {
  const buildOpenCodeUrl = deps.buildOpenCodeUrl;
  const getOpenCodeAuthHeaders = typeof deps.getOpenCodeAuthHeaders === 'function'
    ? deps.getOpenCodeAuthHeaders
    : () => ({});
  const createClient = deps.createClient || createOpencodeClient;

  return async (directory, title) => {
    if (typeof buildOpenCodeUrl !== 'function') {
      const error = new Error('OpenCode URL builder is unavailable');
      error.code = 'OPENCODE_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = createClient({
      baseUrl,
      headers: getOpenCodeAuthHeaders(),
    });
    const response = await client.session.create({
      directory,
      ...(title ? { title } : {}),
    });
    const sessionId = response?.data?.id;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      const error = new Error('failed to create session');
      error.code = 'SESSION_CREATE_FAILED';
      error.statusCode = 502;
      throw error;
    }
    return sessionId.trim();
  };
}
