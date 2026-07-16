import { createCodexAppServerClient } from './app-server-client.js';

const THREAD_PAGE_SIZE = 100;
const MAX_THREAD_PAGES = 50;
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 1_000;
const MAX_IMPORT_THREADS = 500;
const MAX_TRANSCRIPT_LENGTH = 1_000_000;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeComparablePath = (pathModule, value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = pathModule.normalize(value.trim()).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const safeText = (value) => typeof value === 'string' ? value.trim() : '';

const formatUserInput = (input) => {
  if (!isRecord(input)) return '';
  if (input.type === 'text') return safeText(input.text);
  if (input.type === 'image') return `[Image: ${safeText(input.url)}]`;
  if (input.type === 'localImage') return `[Local image: ${safeText(input.path)}]`;
  if (input.type === 'skill') return `[Skill: ${safeText(input.name)} (${safeText(input.path)})]`;
  if (input.type === 'mention') return `[Mention: ${safeText(input.name)} (${safeText(input.path)})]`;
  return safeText(input.type) ? `[Unsupported user input: ${safeText(input.type)}]` : '';
};

const formatCodeBlock = (value) => `\n\n    ${String(value).replace(/\r?\n/g, '\n    ')}\n`;

const formatThreadItem = (item) => {
  if (!isRecord(item)) return '';
  switch (item.type) {
    case 'userMessage': {
      const text = Array.isArray(item.content) ? item.content.map(formatUserInput).filter(Boolean).join('\n') : '';
      return text ? `## User\n\n${text}` : '';
    }
    case 'agentMessage':
      return safeText(item.text) ? `## Codex\n\n${safeText(item.text)}` : '';
    case 'plan':
      return safeText(item.text) ? `## Codex plan\n\n${safeText(item.text)}` : '';
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.map(safeText).filter(Boolean).join('\n') : '';
      return summary ? `### Reasoning summary\n\n${summary}` : '';
    }
    case 'commandExecution': {
      const command = safeText(item.command);
      if (!command) return '';
      const status = safeText(item.status);
      const exitCode = Number.isInteger(item.exitCode) ? `, exit ${item.exitCode}` : '';
      return `### Command${status ? ` (${status}${exitCode})` : ''}${formatCodeBlock(command)}`;
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes)
        ? item.changes
            .map((change) => isRecord(change) ? `- ${safeText(change.kind) || 'changed'}: ${safeText(change.path)}` : '')
            .filter(Boolean)
            .join('\n')
        : '';
      return changes ? `### File changes\n\n${changes}` : '';
    }
    case 'mcpToolCall':
      return `### MCP tool\n\n${safeText(item.server)}/${safeText(item.tool)} (${safeText(item.status) || 'unknown'})`;
    case 'dynamicToolCall':
      return `### Tool\n\n${safeText(item.namespace) ? `${safeText(item.namespace)}/` : ''}${safeText(item.tool)} (${safeText(item.status) || 'unknown'})`;
    case 'webSearch':
      return '### Web search';
    case 'imageView':
      return safeText(item.path) ? `### Viewed image\n\n${safeText(item.path)}` : '';
    case 'contextCompaction':
      return '### Context compacted';
    default: {
      const type = safeText(item.type);
      return type ? `### Codex activity\n\nUnsupported item type: ${type}` : '';
    }
  }
};

export const formatCodexTranscript = (thread) => {
  const title = safeText(thread?.name) || safeText(thread?.preview) || 'Codex conversation';
  const header = [
    '# Imported Codex conversation',
    '',
    `- Title: ${title}`,
    `- Codex thread: ${safeText(thread?.id)}`,
    `- Original project: ${safeText(thread?.cwd)}`,
    `- Created: ${Number.isFinite(thread?.createdAt) ? new Date(thread.createdAt * 1000).toISOString() : 'unknown'}`,
    `- Updated: ${Number.isFinite(thread?.updatedAt) ? new Date(thread.updatedAt * 1000).toISOString() : 'unknown'}`,
  ].join('\n');

  const sections = Array.isArray(thread?.turns)
    ? thread.turns.flatMap((turn) => Array.isArray(turn?.items) ? turn.items.map(formatThreadItem) : []).filter(Boolean)
    : [];
  const transcript = `${header}\n\n---\n\n${sections.join('\n\n---\n\n')}`;
  if (transcript.length <= MAX_TRANSCRIPT_LENGTH) return transcript;
  return `${transcript.slice(0, MAX_TRANSCRIPT_LENGTH)}\n\n---\n\n[Transcript truncated during import]`;
};

const readAllThreads = async (client) => {
  const threads = new Map();
  for (const archived of [false, true]) {
    let cursor = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const response = await client.request('thread/list', {
        archived,
        cursor,
        limit: THREAD_PAGE_SIZE,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      });
      const data = Array.isArray(response?.data) ? response.data : [];
      for (const thread of data) {
        if (safeText(thread?.id)) {
          threads.set(thread.id, { ...thread, archived });
        }
      }
      cursor = safeText(response?.nextCursor) || null;
      if (!cursor) break;
    }
  }
  return Array.from(threads.values());
};

const summarizeConfig = (config) => ({
  model: safeText(config?.model) || null,
  modelProvider: safeText(config?.model_provider) || null,
  reasoningEffort: safeText(config?.model_reasoning_effort) || null,
  approvalPolicy: safeText(config?.approval_policy) || null,
  sandboxMode: safeText(config?.sandbox_mode) || null,
});

const collectProjectTrust = (config, pathModule) => {
  const result = new Map();
  if (!isRecord(config?.projects)) return result;
  for (const [projectPath, entry] of Object.entries(config.projects)) {
    const normalized = normalizeComparablePath(pathModule, projectPath);
    if (!normalized) continue;
    const trustLevel = isRecord(entry) ? safeText(entry.trust_level) : '';
    result.set(normalized, { path: projectPath, trustLevel: trustLevel || null });
  }
  return result;
};

const sessionImportThreadId = (session) => isRecord(session?.metadata) && session.metadata.importSource === 'codex'
  ? safeText(session.metadata.importThreadID)
  : '';

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

const listImportedSessions = async (openCodeClient, directory) => {
  const imported = new Map();
  let start = 0;
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const listResponse = await openCodeClient.session.list(
      { directory, roots: true, limit: SESSION_PAGE_SIZE, start },
      { throwOnError: true },
    );
    const sessions = Array.isArray(listResponse?.data) ? listResponse.data : [];
    for (const session of sessions) {
      const threadId = sessionImportThreadId(session);
      if (threadId) imported.set(threadId, session.id);
    }
    if (sessions.length < SESSION_PAGE_SIZE) return imported;
    start += sessions.length;
  }
  throw new Error('OpenCode session pagination limit was exceeded');
};

export const createCodexImportRuntime = ({
  spawn,
  fsPromises,
  path,
  registerProjects,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  createCodexClient = () => createCodexAppServerClient({ spawn }),
  createOpenCodeClient,
}) => {
  const inspectWithClient = async (client) => {
    const [configResponse, threads] = await Promise.all([
      client.request('config/read', { includeLayers: false }),
      readAllThreads(client),
    ]);
    const config = isRecord(configResponse?.config) ? configResponse.config : {};
    const trustByPath = collectProjectTrust(config, path);
    const projectMap = new Map();

    for (const [normalizedPath, project] of trustByPath) {
      projectMap.set(normalizedPath, { ...project, threadCount: 0, threadIds: [], exists: false });
    }
    for (const thread of threads) {
      const comparablePath = normalizeComparablePath(path, thread?.cwd);
      if (!comparablePath) continue;
      const current = projectMap.get(comparablePath) || {
        path: safeText(thread.cwd),
        trustLevel: trustByPath.get(comparablePath)?.trustLevel || null,
        threadCount: 0,
        threadIds: [],
        exists: false,
      };
      current.threadCount += 1;
      current.threadIds.push(thread.id);
      projectMap.set(comparablePath, current);
    }

    const projects = await Promise.all(Array.from(projectMap.values()).map(async (project) => {
      try {
        const stat = await fsPromises.stat(project.path);
        return { ...project, exists: stat.isDirectory() };
      } catch {
        return project;
      }
    }));

    return {
      config: summarizeConfig(config),
      projects: projects.sort((a, b) => a.path.localeCompare(b.path)),
      threads: threads.map((thread) => ({
        id: thread.id,
        title: safeText(thread.name) || safeText(thread.preview) || 'Codex conversation',
        cwd: safeText(thread.cwd),
        createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : null,
        updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
        archived: thread.archived === true,
      })),
    };
  };

  const inspect = async () => {
    const client = createCodexClient();
    try {
      await client.start();
      return await inspectWithClient(client);
    } finally {
      client.close();
    }
  };

  const applySelection = async ({ threadIds, projectPaths }) => {
    const requestedThreadIds = Array.isArray(threadIds)
      ? Array.from(new Set(threadIds.map(safeText).filter(Boolean)))
      : [];
    const requestedProjectPaths = Array.isArray(projectPaths)
      ? Array.from(new Set(projectPaths.map(safeText).filter(Boolean)))
      : [];
    if (requestedThreadIds.length > MAX_IMPORT_THREADS) {
      throw new Error(`At most ${MAX_IMPORT_THREADS} Codex conversations can be imported at once`);
    }

    const codexClient = createCodexClient();
    try {
      await codexClient.start();
      const [allThreads, configResponse] = await Promise.all([
        readAllThreads(codexClient),
        codexClient.request('config/read', { includeLayers: false }),
      ]);
      const threadById = new Map(allThreads.map((thread) => [thread.id, thread]));
      const selectedThreads = requestedThreadIds.map((id) => threadById.get(id)).filter(Boolean);
      const knownProjectPath = new Map();
      const config = isRecord(configResponse?.config) ? configResponse.config : {};
      for (const project of collectProjectTrust(config, path).values()) {
        const comparable = normalizeComparablePath(path, project.path);
        if (comparable) knownProjectPath.set(comparable, project.path);
      }
      for (const thread of allThreads) {
        const comparable = normalizeComparablePath(path, thread.cwd);
        if (comparable && !knownProjectPath.has(comparable)) knownProjectPath.set(comparable, thread.cwd);
      }

      const selectedProjectPaths = new Map();
      for (const requestedPath of requestedProjectPaths) {
        const comparable = normalizeComparablePath(path, requestedPath);
        if (knownProjectPath.has(comparable)) selectedProjectPaths.set(comparable, knownProjectPath.get(comparable));
      }
      for (const thread of selectedThreads) {
        const comparable = normalizeComparablePath(path, thread.cwd);
        if (comparable) selectedProjectPaths.set(comparable, thread.cwd);
      }

      const projectRegistration = selectedProjectPaths.size > 0
        ? await registerProjects(Array.from(selectedProjectPaths.values()))
        : { added: 0, existing: 0, unavailable: 0 };

      const openCodeClient = createOpenCodeClient({
        baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
        headers: getOpenCodeAuthHeaders(),
      });
      const importedByDirectory = new Map();
      const results = [];

      for (const thread of selectedThreads) {
        const directory = safeText(thread.cwd);
        try {
          const stat = await fsPromises.stat(directory);
          if (!stat.isDirectory()) throw new Error('Codex project directory is unavailable');

          const directoryKey = normalizeComparablePath(path, directory);
          let imported = importedByDirectory.get(directoryKey);
          if (!imported) {
            imported = await listImportedSessions(openCodeClient, directory);
            importedByDirectory.set(directoryKey, imported);
          }

          const existingSessionID = imported.get(thread.id);
          if (existingSessionID) {
            results.push({ threadId: thread.id, status: 'skipped', sessionId: existingSessionID });
            continue;
          }

          const threadResponse = await codexClient.request('thread/read', {
            threadId: thread.id,
            includeTurns: true,
          });
          const fullThread = threadResponse?.thread;
          if (!fullThread) throw new Error('Codex conversation could not be read');

          const title = (safeText(fullThread.name) || safeText(fullThread.preview) || 'Imported Codex conversation').slice(0, 160);
          const createResponse = await openCodeClient.session.create({
            directory,
            title,
            metadata: {
              importSource: 'codex',
              importThreadID: thread.id,
              importFormat: 'transcript-v1',
              importCreatedAt: fullThread.createdAt,
              importUpdatedAt: fullThread.updatedAt,
            },
          }, { throwOnError: true });
          const sessionId = createResponse?.data?.id;
          if (!sessionId) throw new Error('OpenCode did not create an import session');

          try {
            await openCodeClient.session.promptAsync({
              sessionID: sessionId,
              directory,
              noReply: true,
              parts: [{ type: 'text', text: formatCodexTranscript(fullThread) }],
            }, { throwOnError: true });
          } catch (error) {
            try {
              await openCodeClient.session.delete({ sessionID: sessionId, directory }, { throwOnError: true });
            } catch {
              throw new Error(`${errorMessage(error)}; cleanup of the empty OpenCode session also failed`);
            }
            throw error;
          }

          imported.set(thread.id, sessionId);
          results.push({ threadId: thread.id, status: 'imported', sessionId });
        } catch (error) {
          results.push({ threadId: thread.id, status: 'failed', error: errorMessage(error) });
        }
      }

      for (const missingThreadId of requestedThreadIds.filter((id) => !threadById.has(id))) {
        results.push({ threadId: missingThreadId, status: 'failed', error: 'Codex conversation was not found' });
      }

      return {
        projectsAdded: projectRegistration.added,
        projectsExisting: projectRegistration.existing,
        projectsUnavailable: projectRegistration.unavailable,
        results,
      };
    } finally {
      codexClient.close();
    }
  };

  let applyQueue = Promise.resolve();
  const apply = (selection) => {
    const operation = applyQueue.catch(() => {}).then(() => applySelection(selection));
    applyQueue = operation;
    return operation;
  };

  return { inspect, apply };
};
