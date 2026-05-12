import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';
import { Buffer } from 'buffer';
import { createCodexAppServerAdapter } from './codex-appserver.js';

const DEFAULT_MODE_ID = 'build';
const DEFAULT_EFFORT_ID = 'medium';

const MODE_DEFINITIONS = Object.freeze({
  build: {
    id: 'build',
    label: 'Build',
    description: 'Write code and use tools in the workspace',
    threadOptions: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Analyze and propose changes without modifying files',
    threadOptions: {
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    },
  },
});

const EFFORT_OPTIONS = Object.freeze([
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
]);

const COMMAND_OPTIONS = Object.freeze([
  {
    name: 'compact',
    description: 'Summarize the visible conversation to free tokens.',
  },
]);

const resolveCodexHomeDir = () => {
  const explicit = [
    process.env.OPENCHAMBER_CODEX_HOME,
    process.env.CODEX_HOME,
  ]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  if (explicit.length > 0) {
    return explicit[0];
  }

  return path.join(os.homedir(), '.codex');
};

const parsePromptFrontmatter = (content) => {
  if (typeof content !== 'string' || !content.startsWith('---\n')) {
    return { metadata: {}, body: content };
  }

  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { metadata: {}, body: content };
  }

  const frontmatter = content.slice(4, endIndex);
  const body = content.slice(endIndex + 5);
  const metadata = {};

  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim().toLowerCase();
    let value = line.slice(colonIndex + 1).trim();
    if (!value) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    metadata[key] = value;
  }

  return { metadata, body };
};

const buildPromptDescription = (description, argumentHint) => {
  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  const trimmedArgumentHint = typeof argumentHint === 'string' ? argumentHint.trim() : '';

  if (trimmedDescription && trimmedArgumentHint) {
    return `${trimmedDescription} Args: ${trimmedArgumentHint}`;
  }
  if (trimmedDescription) {
    return trimmedDescription;
  }
  if (trimmedArgumentHint) {
    return `Args: ${trimmedArgumentHint}`;
  }
  return undefined;
};

const textDecoder = new TextDecoder();

const createId = (crypto) => `${Date.now().toString(16).padStart(12, '0')}${crypto.randomBytes(4).toString('hex')}`;
let lastSortableTimestamp = 0;
let sortableCounter = 0;
const createSortableId = (prefix, crypto) => {
  const now = Date.now();
  if (now !== lastSortableTimestamp) {
    lastSortableTimestamp = now;
    sortableCounter = 0;
  }
  sortableCounter += 1;

  const value = BigInt(now) * BigInt(0x1000) + BigInt(sortableCounter);
  const bytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((value >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }

  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }

  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let rand = '';
  for (let index = 0; index < 14; index += 1) {
    rand += chars[crypto.randomInt(0, chars.length)];
  }

  return `${prefix}_${hex}${rand}`;
};

const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string') {
    return null;
  }
  const trimmed = directory.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === '/') {
    return normalized;
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const hasSortableCodexPartId = (messageId, partId) => (
  typeof messageId === 'string'
  && typeof partId === 'string'
  && partId.startsWith(`${messageId}_`)
  && /^\d{6}_/.test(partId.slice(messageId.length + 1))
);

const codexPartTypeKey = (part) => {
  if (part?.type === 'tool') {
    return part.tool === 'edit' ? 'file-diff' : 'tool-output';
  }
  return typeof part?.type === 'string' && part.type.length > 0 ? part.type : 'part';
};

const normalizeCodexRecordPartIds = (record, parts) => {
  const messageId = record?.info?.id;
  if (record?.info?.role !== 'assistant' || typeof messageId !== 'string' || parts.length === 0) {
    return parts;
  }

  return parts.map((part, index) => {
    if (hasSortableCodexPartId(messageId, part.id)) {
      return part;
    }
    const previousId = part.id;
    const sequence = String(index + 1).padStart(6, '0');
    const typeKey = codexPartTypeKey(part);
    const nextId = `${messageId}_${sequence}_${typeKey}_${previousId || index + 1}`;
    return {
      ...part,
      id: nextId,
      ...(part.type === 'tool' && (!part.callID || part.callID === previousId) ? { callID: nextId } : {}),
    };
  });
};

const codexThreadItemText = (item) => {
  if (typeof item?.text === 'string') return item.text;
  if (Array.isArray(item?.content)) {
    return item.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(item?.summary) && item.summary.length > 0) return item.summary.join('\n');
  return '';
};

const codexThreadItemToPart = (sessionId, messageId, item, sequence) => {
  const itemId = typeof item?.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : String(sequence);
  const base = {
    id: `${messageId}_${String(sequence).padStart(6, '0')}`,
    sessionID: sessionId,
    messageID: messageId,
  };
  if (item?.type === 'userMessage') {
    return {
      ...base,
      id: `${base.id}_text_${itemId}`,
      type: 'text',
      text: codexThreadItemText(item),
    };
  }
  if (item?.type === 'agentMessage') {
    return {
      ...base,
      id: `${base.id}_text_${itemId}`,
      type: 'text',
      text: codexThreadItemText(item),
    };
  }
  if (item?.type === 'reasoning') {
    return {
      ...base,
      id: `${base.id}_reasoning_${itemId}`,
      type: 'reasoning',
      text: codexThreadItemText(item),
    };
  }
  if (item?.type === 'commandExecution') {
    const partId = `${base.id}_tool-output_${itemId}`;
    return {
      ...base,
      id: partId,
      type: 'tool',
      tool: 'bash',
      callID: partId,
      state: {
        status: item.status === 'failed' ? 'error' : item.status === 'running' ? 'running' : 'completed',
        input: { command: typeof item.command === 'string' ? item.command : '' },
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
      },
    };
  }
  return null;
};

const toFiniteTokenNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const normalizeCodexTokenUsageBreakdown = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    input: toFiniteTokenNumber(value.inputTokens ?? value.input_tokens),
    output: toFiniteTokenNumber(value.outputTokens ?? value.output_tokens),
    reasoning: toFiniteTokenNumber(value.reasoningOutputTokens ?? value.reasoning_output_tokens),
    cache: {
      read: toFiniteTokenNumber(value.cachedInputTokens ?? value.cached_input_tokens),
      write: 0,
    },
    total: toFiniteTokenNumber(value.totalTokens ?? value.total_tokens),
  };
};

const normalizeCodexMessageTokens = (usage) => {
  const last = normalizeCodexTokenUsageBreakdown(usage?.last);
  if (!last) {
    return null;
  }

  const contextWindow = toFiniteTokenNumber(usage?.modelContextWindow ?? usage?.model_context_window);
  return {
    input: last.input,
    output: last.output,
    reasoning: last.reasoning,
    cache: last.cache,
    ...(last.total > 0 ? { total: last.total } : {}),
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
};

const hasUsableTokenUsage = (tokens) => {
  if (!tokens || typeof tokens !== 'object') {
    return false;
  }
  return toFiniteTokenNumber(tokens.total) > 0
    || toFiniteTokenNumber(tokens.input) > 0
    || toFiniteTokenNumber(tokens.output) > 0
    || toFiniteTokenNumber(tokens.reasoning) > 0
    || toFiniteTokenNumber(tokens?.cache?.read) > 0
    || toFiniteTokenNumber(tokens.contextWindow) > 0;
};

const attachTokensToLatestAssistantRecord = (records, tokens) => {
  if (!hasUsableTokenUsage(tokens)) {
    return records;
  }

  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.info?.role === 'assistant') {
      const existingTokens = records[index].info.tokens;
      if (hasUsableTokenUsage(existingTokens)) {
        return records;
      }
      const nextRecords = records.slice();
      nextRecords[index] = {
        ...records[index],
        info: {
          ...records[index].info,
          tokens,
        },
      };
      return nextRecords;
    }
  }

  return records;
};

const cloneRecord = (record) => {
  const info = {
    ...record.info,
    time: record.info?.time ? { ...record.info.time } : undefined,
    model: record.info?.model ? { ...record.info.model } : undefined,
  };
  const parts = Array.isArray(record.parts)
    ? record.parts.map((part) => ({ ...part }))
    : [];
  return {
    info,
    parts: normalizeCodexRecordPartIds({ ...record, info }, parts),
  };
};

const normalizeSessionEntry = (entry) => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const session = entry.session && typeof entry.session === 'object' ? entry.session : null;
  const sessionId = typeof session?.id === 'string' ? session.id.trim() : '';
  if (!sessionId) {
    return null;
  }

  const directory = normalizeDirectory(session?.directory);
  const createdAt = typeof session?.time?.created === 'number' ? session.time.created : Date.now();
  const updatedAt = typeof session?.time?.updated === 'number' ? session.time.updated : createdAt;
  const archivedAt = typeof session?.time?.archived === 'number' ? session.time.archived : null;
  const mode = typeof entry.mode === 'string' && MODE_DEFINITIONS[entry.mode]
    ? entry.mode
    : DEFAULT_MODE_ID;
  const modelId = typeof entry.modelId === 'string' && entry.modelId.trim().length > 0
    ? entry.modelId.trim()
    : null;
  const effort = typeof entry.effort === 'string' && entry.effort.trim().length > 0
    ? entry.effort.trim()
    : DEFAULT_EFFORT_ID;
  const records = Array.isArray(entry.records)
    ? entry.records
        .filter((record) => record?.info?.id)
        .map((record) => cloneRecord(record))
    : [];

  return {
    session: {
      id: sessionId,
      title: typeof session?.title === 'string' ? session.title : 'New session',
      directory,
      parentID: typeof session?.parentID === 'string' ? session.parentID : null,
      time: {
        created: createdAt,
        updated: updatedAt,
        ...(archivedAt ? { archived: archivedAt } : {}),
      },
      backendId: 'codex',
      share: session?.share ?? null,
    },
    threadId: typeof entry.threadId === 'string' && entry.threadId.trim().length > 0 ? entry.threadId.trim() : null,
    mode,
    modelId,
    effort,
    records,
  };
};

const statusIsArchived = (status) => {
  if (!status || typeof status !== 'object') return false;
  return status.type === 'archived' || status.state === 'archived';
};

const toSessionTimeMillis = (value, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  // Codex thread/list timestamps are seconds.
  return value > 1e12 ? value : Math.floor(value * 1000);
};

const isTextLikeMime = (mime) => {
  if (typeof mime !== 'string') {
    return false;
  }
  const value = mime.toLowerCase();
  return value.startsWith('text/')
    || value === 'application/json'
    || value === 'application/xml'
    || value === 'application/javascript'
    || value === 'application/typescript'
    || value === 'application/yaml'
    || value === 'application/x-yaml';
};

const parseDataUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith('data:')) {
    return null;
  }

  const commaIndex = url.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }

  const header = url.slice(5, commaIndex);
  const content = url.slice(commaIndex + 1);
  const [mimePart, ...flagParts] = header.split(';');
  const mime = mimePart || 'application/octet-stream';
  const isBase64 = flagParts.includes('base64');

  try {
    const buffer = isBase64
      ? Buffer.from(content, 'base64')
      : Buffer.from(decodeURIComponent(content), 'utf8');
    return { mime, buffer };
  } catch {
    return null;
  }
};

const formatAttachedText = (filename, text) => {
  const label = filename || 'attachment';
  return `Attached file: ${label}\n\n${text}`;
};

const deriveSessionTitleFromParts = (parts = []) => {
  const textParts = Array.isArray(parts)
    ? parts.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    : [];

  const combined = textParts
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!combined) {
    return null;
  }

  const firstLine = combined
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  const normalized = firstLine.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77).trimEnd()}...` : normalized;
};

export const createCodexBackendRuntime = (dependencies) => {
  const {
    crypto,
    fsPromises,
    sessionsFilePath,
    publishEvent,
  } = dependencies;

  let loaded = false;
  let writeLock = Promise.resolve();
  const sessions = new Map();
  const runControllers = new Map();
  const eventClients = new Set();

  const emitEvent = (directory, payload) => {
    const normalizedDirectory = normalizeDirectory(directory) || 'global';
    const eventPayload = {
      id: createId(crypto),
      directory: normalizedDirectory,
      ...payload,
    };
    publishEvent?.({
      payload: eventPayload,
      directory: normalizedDirectory,
      eventId: eventPayload.id,
    });
    const encoded = `data: ${JSON.stringify(eventPayload)}\n\n`;

    for (const client of eventClients) {
      if (client.directory && client.directory !== normalizedDirectory) {
        continue;
      }
      try {
        client.res.write(encoded);
      } catch {
      }
    }
  };

  const ensureLoaded = async () => {
    if (loaded) {
      return;
    }

    try {
      const raw = await fsPromises.readFile(sessionsFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      sessions.clear();
      for (const entry of entries) {
        const normalized = normalizeSessionEntry(entry);
        if (normalized) {
          sessions.set(normalized.session.id, normalized);
        }
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        console.warn('Failed to read Codex sessions:', error);
      }
      sessions.clear();
    }

    loaded = true;
  };

  const loadCustomPromptCommands = async () => {
    const promptsDir = path.join(resolveCodexHomeDir(), 'prompts');

    let entries;
    try {
      entries = await fsPromises.readdir(promptsDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const promptFiles = entries
      .filter((entry) => entry?.isFile?.() && entry.name.toLowerCase().endsWith('.md'))
      .sort((left, right) => left.name.localeCompare(right.name));

    const commands = await Promise.all(promptFiles.map(async (entry) => {
      const absolutePath = path.join(promptsDir, entry.name);
      try {
        const raw = await fsPromises.readFile(absolutePath, 'utf8');
        const { metadata, body } = parsePromptFrontmatter(raw);
        const stem = entry.name.replace(/\.md$/i, '').trim();
        if (!stem) {
          return null;
        }

        return {
          name: `prompts:${stem}`,
          description: buildPromptDescription(metadata.description, metadata['argument-hint']),
          template: body.trim(),
          executionMode: 'prompt-text',
        };
      } catch {
        return null;
      }
    }));

    return commands.filter(Boolean);
  };

  const persist = async () => {
    const payload = {
      version: 1,
      sessions: Array.from(sessions.values())
        .sort((a, b) => (b.session.time?.updated ?? 0) - (a.session.time?.updated ?? 0)),
    };

    writeLock = writeLock.then(async () => {
      await fsPromises.mkdir(path.dirname(sessionsFilePath), { recursive: true });
      await fsPromises.writeFile(sessionsFilePath, JSON.stringify(payload, null, 2), 'utf8');
    });

    return writeLock;
  };

  const getEntry = async (sessionId) => {
    await ensureLoaded();
    return sessions.get(sessionId) || null;
  };

  const saveEntry = async (entry) => {
    sessions.set(entry.session.id, entry);
    await persist();
    return entry;
  };

  const buildSession = async (input = {}) => {
    const sessionId = createId(crypto);
    const directory = normalizeDirectory(input.directory);
    const now = Date.now();
    const mode = typeof input.mode === 'string' && MODE_DEFINITIONS[input.mode]
      ? input.mode
      : DEFAULT_MODE_ID;
  const modelId = typeof input.modelId === 'string' && input.modelId.trim().length > 0
    ? input.modelId.trim()
      : await resolveDefaultModelId();
    const effort = typeof input.effort === 'string' && input.effort.trim().length > 0
      ? input.effort.trim()
      : DEFAULT_EFFORT_ID;

    return {
      session: {
        id: sessionId,
        title: typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim() : 'New session',
        directory,
        parentID: typeof input.parentID === 'string' ? input.parentID : null,
        time: {
          created: now,
          updated: now,
        },
        backendId: 'codex',
        share: null,
      },
      threadId: null,
      mode,
      modelId,
      effort,
      records: [],
    };
  };

  const buildTextPart = (sessionId, messageId, text) => ({
    id: createId(crypto),
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  });

  const buildFilePart = (sessionId, messageId, file) => ({
    id: createId(crypto),
    sessionID: sessionId,
    messageID: messageId,
    type: 'file',
    mime: typeof file?.mime === 'string' ? file.mime : 'application/octet-stream',
    ...(typeof file?.filename === 'string' ? { filename: file.filename } : {}),
    url: typeof file?.url === 'string' ? file.url : '',
  });

  const buildMessageRecord = ({ sessionId, role, parts, modelId, mode, effort, parentMessageId }) => {
    const messageId = createSortableId('msg', crypto);
    const now = Date.now();

    return {
      info: {
        id: messageId,
        sessionID: sessionId,
        role,
        ...(typeof parentMessageId === 'string' && parentMessageId.trim().length > 0 ? { parentID: parentMessageId.trim() } : {}),
        agent: mode,
        mode,
        variant: effort,
        model: {
          providerID: 'codex',
          modelID: modelId,
        },
        providerID: 'codex',
        modelID: modelId,
        time: {
          created: now,
          completed: now,
        },
        ...(role === 'assistant' ? { finish: 'stop' } : {}),
      },
      parts,
    };
  };

  const appendRecord = (entry, record) => {
    const nextEntry = {
      ...entry,
      session: {
        ...entry.session,
        time: {
          ...entry.session.time,
          updated: Date.now(),
        },
      },
      records: [...entry.records, record],
    };
    return nextEntry;
  };

  const updateThreadMetadata = (entry, metadata) => ({
    ...entry,
    ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {}),
    ...(metadata.mode ? { mode: metadata.mode } : {}),
    ...(metadata.modelId ? { modelId: metadata.modelId } : {}),
    ...(metadata.effort ? { effort: metadata.effort } : {}),
    session: {
      ...entry.session,
      time: {
        ...entry.session.time,
        updated: Date.now(),
      },
    },
  });

  const toCodexInput = async (parts = []) => {
    const textChunks = [];
    // Store image data URLs directly — the Codex app-server accepts data: URLs
    // in the turn/start input as { type: 'image', url: 'data:...' }.
    const imageUrls = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
        textChunks.push(part.text);
        continue;
      }

      if (part.type !== 'file') {
        continue;
      }

      const filename = typeof part.filename === 'string' ? part.filename : 'attachment';
      const mime = typeof part.mime === 'string' ? part.mime : 'application/octet-stream';
      const url = typeof part.url === 'string' ? part.url : '';

      // Handle file:// images — read the file and convert to a data URL
      if (url.startsWith('file://') && mime.startsWith('image/')) {
        try {
          const filePath = fileURLToPath(url);
          const fileBuffer = await fsPromises.readFile(filePath);
          const base64 = fileBuffer.toString('base64');
          imageUrls.push(`data:${mime};base64,${base64}`);
          continue;
        } catch (err) {
          console.warn(`[codex-backend] Failed to read file URL image: ${url}`, err);
        }
      }

      // Handle data: URL images — pass through directly
      const dataUrl = parseDataUrl(url);
      if (dataUrl) {
        if (dataUrl.mime.startsWith('image/')) {
          // Pass the original data URL string directly to Codex
          imageUrls.push(url);
          continue;
        }

        if (isTextLikeMime(dataUrl.mime)) {
          textChunks.push(formatAttachedText(filename, textDecoder.decode(dataUrl.buffer)));
          continue;
        }
      }

      if (url.startsWith('file://') && isTextLikeMime(mime)) {
        try {
          const filePath = fileURLToPath(url);
          const content = await fsPromises.readFile(filePath, 'utf8');
          textChunks.push(formatAttachedText(filename, content));
          continue;
        } catch (err) {
          console.warn(`[codex-backend] Failed to read text file attachment: ${url}`, err);
        }
      }

      textChunks.push(`Attached file: ${filename} (${mime})`);
    }

    // No temp files needed — cleanup is a no-op
    const cleanup = async () => {};

    if (imageUrls.length === 0) {
      return {
        input: textChunks.join('\n\n'),
        cleanup,
      };
    }

    return {
      input: [
        ...(textChunks.length > 0 ? [{ type: 'text', text: textChunks.join('\n\n') }] : []),
        ...imageUrls.map((dataUrlStr) => ({ type: 'image', url: dataUrlStr })),
      ],
      cleanup,
    };
  };

  // --- Codex app-server adapter (replaces SDK) ---
  const appServer = createCodexAppServerAdapter({
    crypto,
    emitEvent,
    onTurnCompleted: async (sessionId, finalText, turnParams, finalParts) => {
      // Clear the run controller so the session is no longer marked as running
      runControllers.delete(sessionId);

      try {
        let entry = await getEntry(sessionId);
        if (!entry) {
          return;
        }

        // Persist the thread ID so we can resume after restart
        const threadId = appServer.getThreadId(sessionId);
        if (threadId && entry.threadId !== threadId) {
          entry = updateThreadMetadata(entry, { threadId });
        }

        // Only persist an assistant record if we got content.
        // Do NOT emit record events here — the streaming deltas already
        // pushed message.part.updated events to the UI in real time.
        // We only need to persist the final record to disk.
        if (finalText != null) {
          const messageId = typeof turnParams?.messageId === 'string' && turnParams.messageId.trim().length > 0
            ? turnParams.messageId.trim()
            : createSortableId('msg', crypto);

          // Build parts array from the structured finalParts (text, reasoning, tool)
          // so that reasoning traces and tool calls survive a page refresh.
          const recordParts = [];
          if (Array.isArray(finalParts) && finalParts.length > 0) {
            for (const fp of finalParts) {
              if (fp.type === 'reasoning' && fp.text) {
                recordParts.push({
                  id: typeof fp.id === 'string' && fp.id.length > 0 ? fp.id : createId(crypto),
                  sessionID: entry.session.id,
                  messageID: messageId,
                  type: 'reasoning',
                  text: fp.text,
                  time: fp.time || { start: Date.now(), end: Date.now() },
                });
              } else if (fp.type === 'text' && fp.text) {
                recordParts.push({
                  ...buildTextPart(entry.session.id, messageId, fp.text),
                  ...(typeof fp.id === 'string' && fp.id.length > 0 ? { id: fp.id } : {}),
                });
              } else if (fp.type === 'tool' && fp.state) {
                const partId = typeof fp.id === 'string' && fp.id.length > 0 ? fp.id : createId(crypto);
                recordParts.push({
                  id: partId,
                  sessionID: entry.session.id,
                  messageID: messageId,
                  type: 'tool',
                  callID: fp.callID || partId,
                  tool: fp.tool || 'unknown',
                  state: fp.state,
                });
              }
            }
          }

          // Fallback: if no structured parts, create a single text part
          if (recordParts.length === 0) {
            const assistantText = typeof finalText === 'string' && finalText.trim().length > 0
              ? finalText
              : 'Done.';
            recordParts.push(buildTextPart(entry.session.id, messageId, assistantText));
          }

          const assistantRecord = buildMessageRecord({
            sessionId: entry.session.id,
            role: 'assistant',
            parts: recordParts,
            modelId: entry.modelId,
            mode: entry.mode,
            effort: entry.effort,
            parentMessageId: turnParams?.parentMessageId,
          });
          assistantRecord.info.id = messageId;
          if (turnParams?.tokens && typeof turnParams.tokens === 'object') {
            assistantRecord.info.tokens = turnParams.tokens;
          }

          // Ensure all parts reference the record's message ID
          for (const part of assistantRecord.parts) {
            part.messageID = assistantRecord.info.id;
          }

          entry = appendRecord(entry, assistantRecord);
          await saveEntry(entry);
        }
      } catch (err) {
        console.error(`[codex-backend] onTurnCompleted error for ${sessionId}:`, err);
      }
    },
    onTurnError: (sessionId, error) => {
      // Handled by the appserver adapter's onExit / error events
    },
    onThreadNameUpdated: async (sessionId, title) => {
      try {
        const entry = await getEntry(sessionId);
        if (!entry || entry.session.title === title) {
          return;
        }
        const nextEntry = {
          ...entry,
          session: {
            ...entry.session,
            title,
            time: {
              ...entry.session.time,
              updated: Date.now(),
            },
          },
        };
        await saveEntry(nextEntry);
        emitSessionUpdate('session.updated', nextEntry.session);
      } catch (err) {
        console.error(`[codex-backend] thread name update failed for ${sessionId}:`, err);
      }
    },
  });

  const resolveDefaultModelId = async () => {
    const modelOptions = await appServer.listModels();
    if (modelOptions.length === 0) {
      throw new Error('Codex model list is empty. Ensure the Codex CLI is installed and authenticated.');
    }
    return modelOptions.find((option) => option.isDefault)?.id || modelOptions[0].id;
  };

  const emitRecordEvents = (directory, record) => {
    emitEvent(directory, {
      type: 'message.updated',
      properties: {
        info: record.info,
        directory,
      },
    });

    for (const part of record.parts) {
      emitEvent(directory, {
        type: 'message.part.updated',
        properties: {
          part,
          directory,
        },
      });
    }
  };

  const emitSessionUpdate = (type, session) => {
    // Session lifecycle events (created, updated, deleted) are broadcast to
    // ALL SSE clients so the sidebar picks them up regardless of which
    // directory the client is connected to.
    const eventPayload = {
      id: createId(crypto),
      directory: normalizeDirectory(session.directory) || 'global',
      type,
      properties: {
        info: session,
        directory: session.directory,
      },
    };
    const encoded = `data: ${JSON.stringify(eventPayload)}\n\n`;

    for (const client of eventClients) {
      try {
        client.res.write(encoded);
      } catch {
      }
    }
  };

  const setBusyStatus = (sessionId, directory, status) => {
    emitEvent(directory, {
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status,
        info: status,
        directory,
      },
    });

    if (status.type === 'idle') {
      emitEvent(directory, {
        type: 'session.idle',
        properties: {
          sessionID: sessionId,
          directory,
        },
      });
    }
  };

  const hydrateSessionsFromCodexList = async ({ directory, archived, limit }) => {
    let threads = [];
    try {
      threads = await appServer.listThreads({
        ...(directory ? { cwd: directory } : {}),
        ...(typeof archived === 'boolean' ? { archived } : {}),
        ...(limit ? { limit } : {}),
      });
    } catch (error) {
      console.warn('[codex-backend] thread/list failed:', error?.message || error);
      return;
    }

    if (!Array.isArray(threads) || threads.length === 0) {
      return;
    }

    let changed = false;
    for (const thread of threads) {
      if (!thread || typeof thread !== 'object') continue;
      const threadId = typeof thread.id === 'string' ? thread.id.trim() : '';
      if (!threadId) continue;
      const cwd = normalizeDirectory(thread.cwd);
      if (directory && cwd !== directory) continue;
      const created = toSessionTimeMillis(thread.createdAt, Date.now());
      const updated = toSessionTimeMillis(thread.updatedAt, created);
      const isArchived = statusIsArchived(thread.status);
      const title = typeof thread.name === 'string' && thread.name.trim().length > 0
        ? thread.name.trim()
        : typeof thread.preview === 'string' && thread.preview.trim().length > 0
          ? thread.preview.trim().slice(0, 120)
          : 'New session';

      const existing = Array.from(sessions.values()).find((entry) => entry.threadId === threadId);
      if (existing) {
        const existingCreated = typeof existing.session?.time?.created === 'number'
          ? existing.session.time.created
          : created;
        const existingUpdated = typeof existing.session?.time?.updated === 'number'
          ? existing.session.time.updated
          : existingCreated;
        const nextCreated = Math.min(existingCreated, created);
        const nextUpdated = Math.max(existingUpdated, updated);
        const nextEntry = {
          ...existing,
          session: {
            ...existing.session,
            title,
            directory: cwd,
            time: {
              ...existing.session.time,
              created: nextCreated,
              updated: nextUpdated,
              ...(isArchived ? { archived: nextUpdated } : {}),
            },
          },
          threadId,
        };
        if (JSON.stringify(nextEntry.session) !== JSON.stringify(existing.session) || nextEntry.threadId !== existing.threadId) {
          sessions.set(existing.session.id, nextEntry);
          changed = true;
        }
        continue;
      }

      const sessionId = createId(crypto);
      sessions.set(sessionId, {
        session: {
          id: sessionId,
          title,
          directory: cwd,
          parentID: null,
          time: {
            created,
            updated,
            ...(isArchived ? { archived: updated } : {}),
          },
          backendId: 'codex',
          share: null,
        },
        threadId,
        mode: DEFAULT_MODE_ID,
        modelId: null,
        effort: DEFAULT_EFFORT_ID,
        records: [],
      });
      changed = true;
    }

    if (changed) {
      await persist();
    }
  };

  const hydrateEntryMessagesFromCodexThread = async (entry) => {
    if (!entry?.threadId || entry.records.length > 0 || !appServer.readThread) {
      return entry;
    }

    const thread = await appServer.readThread({ threadId: entry.threadId, includeTurns: true }).catch((error) => {
      console.warn('[codex-backend] thread/read failed:', error?.message || error);
      return null;
    });
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    if (turns.length === 0) {
      return entry;
    }

    const effectiveModelId = typeof entry.modelId === 'string' && entry.modelId.trim().length > 0
      ? entry.modelId
      : await resolveDefaultModelId();

    const records = [];
    let sequence = 0;
    let previousMessageId = null;
    for (const turn of turns) {
      const startedAt = toSessionTimeMillis(turn?.startedAt, entry.session.time?.created ?? Date.now());
      const completedAt = toSessionTimeMillis(turn?.completedAt, startedAt);
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        const role = item?.type === 'userMessage'
          ? 'user'
          : item?.type === 'agentMessage' || item?.type === 'reasoning' || item?.type === 'commandExecution'
            ? 'assistant'
            : null;
        if (!role) continue;
        sequence += 1;
        const itemId = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : String(sequence);
        const messageId = `msg_${entry.session.id}_${String(sequence).padStart(6, '0')}_${itemId}`;
        const part = codexThreadItemToPart(entry.session.id, messageId, item, 1);
        if (!part) continue;
        records.push({
          info: {
            id: messageId,
            sessionID: entry.session.id,
            role,
            ...(role === 'assistant' && previousMessageId ? { parentID: previousMessageId } : {}),
            agent: entry.mode,
            mode: entry.mode,
            variant: entry.effort,
            model: {
              providerID: 'codex',
              modelID: effectiveModelId,
            },
            providerID: 'codex',
            modelID: effectiveModelId,
            time: {
              created: startedAt,
              completed: completedAt,
            },
            ...(role === 'assistant' ? { finish: 'stop' } : {}),
          },
          parts: [part],
        });
        previousMessageId = messageId;
      }
    }

    if (records.length === 0) {
      return entry;
    }

    const restoredTokens = appServer.resumeThreadForUsage
      ? normalizeCodexMessageTokens(await appServer.resumeThreadForUsage({
          threadId: entry.threadId,
          directory: entry.session.directory,
          model: effectiveModelId,
        }).catch((error) => {
          console.warn('[codex-backend] thread/resume token usage failed:', error?.message || error);
          return null;
        }))
      : null;
    if (restoredTokens) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.info?.role === 'assistant') {
          records[index] = {
            ...records[index],
            info: {
              ...records[index].info,
              tokens: restoredTokens,
            },
          };
          break;
        }
      }
    }

    const nextEntry = {
      ...entry,
      modelId: effectiveModelId,
      records,
    };
    await saveEntry(nextEntry);
    return nextEntry;
  };

  const ensureEntryTokenUsage = async (entry) => {
    if (!entry?.threadId || !appServer.resumeThreadForUsage) {
      return entry;
    }

    const latestAssistant = [...entry.records].reverse().find((record) => record?.info?.role === 'assistant');
    if (!latestAssistant || hasUsableTokenUsage(latestAssistant.info?.tokens)) {
      return entry;
    }

    const effectiveModelId = typeof entry.modelId === 'string' && entry.modelId.trim().length > 0
      ? entry.modelId
      : await resolveDefaultModelId();

    const restoredTokens = normalizeCodexMessageTokens(await appServer.resumeThreadForUsage({
      threadId: entry.threadId,
      directory: entry.session.directory,
      model: effectiveModelId,
    }).catch((error) => {
      console.warn('[codex-backend] thread/resume token usage failed:', error?.message || error);
      return null;
    }));
    const records = attachTokensToLatestAssistantRecord(entry.records, restoredTokens);
    if (records === entry.records) {
      return entry;
    }

    const nextEntry = {
      ...entry,
      modelId: effectiveModelId,
      records,
    };
    await saveEntry(nextEntry);
    return nextEntry;
  };

  const ensureEntryRecordModelAttribution = async (entry) => {
    const needsRepair = entry.records.some((record) => {
      const info = record?.info;
      if (!info || typeof info !== 'object') return false;
      const infoProvider = typeof info.providerID === 'string' && info.providerID.trim().length > 0;
      const infoModel = typeof info.modelID === 'string' && info.modelID.trim().length > 0;
      const modelProvider = typeof info.model?.providerID === 'string' && info.model.providerID.trim().length > 0;
      const modelModel = typeof info.model?.modelID === 'string' && info.model.modelID.trim().length > 0;
      return !infoProvider || !infoModel || !modelProvider || !modelModel;
    });

    if (!needsRepair) {
      return entry;
    }

    const effectiveModelId = typeof entry.modelId === 'string' && entry.modelId.trim().length > 0
      ? entry.modelId
      : await resolveDefaultModelId();

    const repairedRecords = entry.records.map((record) => {
      const info = record?.info;
      if (!info || typeof info !== 'object') {
        return record;
      }
      return {
        ...record,
        info: {
          ...info,
          providerID: 'codex',
          modelID: effectiveModelId,
          model: {
            ...(info.model && typeof info.model === 'object' ? info.model : {}),
            providerID: 'codex',
            modelID: effectiveModelId,
          },
        },
      };
    });

    const nextEntry = {
      ...entry,
      modelId: effectiveModelId,
      records: repairedRecords,
    };
    await saveEntry(nextEntry);
    return nextEntry;
  };

  const listSessions = async (input = {}) => {
    await ensureLoaded();
    const directory = normalizeDirectory(input.directory);
    const rootsOnly = input.roots !== false;
    const archived = input.archived === true;
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : null;

    await hydrateSessionsFromCodexList({ directory, archived, limit }).catch(() => {});

    let result = Array.from(sessions.values())
      .map((entry) => ({ ...entry.session }))
      .filter((session) => (directory ? session.directory === directory : true))
      .filter((session) => (rootsOnly ? !session.parentID : true))
      .filter((session) => (archived ? Boolean(session.time?.archived) : !session.time?.archived))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

    if (limit) {
      result = result.slice(0, limit);
    }

    return result;
  };

  const createSession = async (input = {}) => {
    await ensureLoaded();
    const entry = await buildSession(input);
    await saveEntry(entry);
    emitSessionUpdate('session.created', entry.session);
    return { ...entry.session };
  };

  const forkSession = async (input = {}) => {
    const entry = await getEntry(input.sessionID);
    if (!entry) {
      throw new Error('Session not found');
    }

    const forkedEntry = await buildSession({
      directory: entry.session.directory,
      parentID: entry.session.id,
      mode: entry.mode,
      modelId: entry.modelId,
      effort: entry.effort,
    });

    await saveEntry(forkedEntry);
    emitSessionUpdate('session.created', forkedEntry.session);
    return { ...forkedEntry.session };
  };

  const getSession = async (input = {}) => {
    let entry = await getEntry(input.sessionID);
    if (!entry && typeof input.directory === 'string') {
      await hydrateSessionsFromCodexList({ directory: normalizeDirectory(input.directory), archived: false }).catch(() => {});
      entry = await getEntry(input.sessionID);
    }
    return entry ? { ...entry.session } : null;
  };

  const getMessages = async (input = {}) => {
    let entry = await getEntry(input.sessionID);
    if (!entry && typeof input.directory === 'string') {
      await hydrateSessionsFromCodexList({ directory: normalizeDirectory(input.directory), archived: false }).catch(() => {});
      entry = await getEntry(input.sessionID);
    }
    if (!entry) {
      return [];
    }
    entry = await hydrateEntryMessagesFromCodexThread(entry);
    entry = await ensureEntryRecordModelAttribution(entry);
    entry = await ensureEntryTokenUsage(entry);

    let records = entry.records.map((record) => cloneRecord(record));
    if (typeof input.before === 'string' && input.before.trim().length > 0) {
      records = records.filter((record) => record.info.id < input.before);
    }
    if (typeof input.limit === 'number' && input.limit > 0) {
      records = records.slice(-input.limit);
    }
    return records;
  };

  const promptAsync = async (input = {}) => {
    const entry = await getEntry(input.sessionID);
    if (!entry) {
      throw new Error('Session not found');
    }
    if (runControllers.has(entry.session.id)) {
      throw new Error('Session is already running');
    }

    const mode = typeof input.agent === 'string' && MODE_DEFINITIONS[input.agent]
      ? input.agent
      : entry.mode;
    const modelId = typeof input.model?.modelID === 'string' && input.model.modelID.trim().length > 0
      ? input.model.modelID.trim()
      : entry.modelId || await resolveDefaultModelId();
    const effort = typeof input.variant === 'string' && input.variant.trim().length > 0
      ? input.variant.trim()
      : entry.effort;

    const userParts = Array.isArray(input.parts)
      ? input.parts.map((part) => {
          if (part?.type === 'text') {
            return buildTextPart(entry.session.id, input.messageID || createSortableId('msg', crypto), typeof part.text === 'string' ? part.text : '');
          }
          if (part?.type === 'file') {
            return buildFilePart(entry.session.id, input.messageID || createSortableId('msg', crypto), part);
          }
          return null;
        }).filter(Boolean)
      : [];

    const userRecord = buildMessageRecord({
      sessionId: entry.session.id,
      role: 'user',
      parts: userParts,
      modelId,
      mode,
      effort,
    });
    if (typeof input.messageID === 'string' && input.messageID.trim().length > 0) {
      userRecord.info.id = input.messageID.trim();
      for (const part of userRecord.parts) {
        part.messageID = userRecord.info.id;
      }
    }

    let nextEntry = appendRecord(entry, userRecord);
    nextEntry = updateThreadMetadata(nextEntry, { mode, modelId, effort });
    if ((!entry.records || entry.records.length === 0) && nextEntry.session.title === 'New session') {
      const derivedTitle = deriveSessionTitleFromParts(input.parts);
      if (derivedTitle) {
        nextEntry = {
          ...nextEntry,
          session: {
            ...nextEntry.session,
            title: derivedTitle,
            time: {
              ...nextEntry.session.time,
              updated: Date.now(),
            },
          },
        };
      }
    }
    await saveEntry(nextEntry);
    emitRecordEvents(nextEntry.session.directory, userRecord);
    emitSessionUpdate('session.updated', nextEntry.session);

    // Mark session as running
    runControllers.set(entry.session.id, true);
    setBusyStatus(entry.session.id, nextEntry.session.directory, { type: 'busy' });

    // Resolve mode-specific thread options, with optional sandbox override
    const modeConfig = MODE_DEFINITIONS[mode] || MODE_DEFINITIONS[DEFAULT_MODE_ID];
    const sandboxOverride = input.sandboxOverride;
    const effectiveSandbox = sandboxOverride === 'danger-full-access'
      ? 'danger-full-access'
      : modeConfig.threadOptions.sandboxMode;
    const effectiveApprovalPolicy = sandboxOverride === 'danger-full-access'
      ? 'never'
      : modeConfig.threadOptions.approvalPolicy;

    const { input: codexInput, cleanup } = await toCodexInput(input.parts);

    try {
      // Get or create app-server process
      await appServer.getOrCreateProcess(entry.session.id, nextEntry.session.directory, {
        model: modelId,
        approvalPolicy: effectiveApprovalPolicy,
        sandbox: effectiveSandbox,
        threadId: nextEntry.threadId,
      });

      // Persist the thread ID immediately so it survives restarts
      const threadId = appServer.getThreadId(entry.session.id);
      if (threadId && nextEntry.threadId !== threadId) {
        nextEntry = updateThreadMetadata(nextEntry, { threadId });
        await saveEntry(nextEntry);
      }

      // Build the assistant placeholder record for streaming
      const assistantRecord = buildMessageRecord({
        sessionId: entry.session.id,
        role: 'assistant',
        parts: [],
        modelId,
        mode,
        effort,
        parentMessageId: userRecord.info.id,
      });

      // Build codex-compatible input array
      const turnInput = [];
      if (typeof codexInput === 'string') {
        if (codexInput.trim()) {
          turnInput.push({ type: 'text', text: codexInput, text_elements: [] });
        }
      } else if (Array.isArray(codexInput)) {
        for (const item of codexInput) {
          if (item.type === 'text') {
            turnInput.push({ type: 'text', text: item.text, text_elements: [] });
          } else if (item.type === 'image') {
            turnInput.push({ type: 'image', url: item.url });
          }
        }
      }

      // Validate that we have non-empty input to send
      if (turnInput.length === 0) {
        throw new Error('Cannot start turn with empty input — message had no text or processable attachments');
      }

      // Start the turn — events will stream via the adapter's notification handler
      await appServer.startTurn(entry.session.id, turnInput, assistantRecord, {
        model: modelId,
        effort: effort || DEFAULT_EFFORT_ID,
        mode,
      });

      // Update stored threadId if the adapter now has one
      // (The onTurnCompleted callback handles persisting the assistant record
      // including text, reasoning, and tool parts)

      return { ok: true };
    } catch (error) {
      runControllers.delete(entry.session.id);
      setBusyStatus(entry.session.id, nextEntry.session.directory, { type: 'idle' });

      emitEvent(nextEntry.session.directory, {
        type: 'session.error',
        properties: {
          sessionID: nextEntry.session.id,
          error: {
            message: error instanceof Error ? error.message : 'Codex run failed',
          },
          directory: nextEntry.session.directory,
        },
      });
      throw error;
    } finally {
      await cleanup();
    }
  };

  const abortSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID : '';
    runControllers.delete(sessionId);

    try {
      await appServer.abort(sessionId);
    } catch {
      // best effort
    }

    const entry = await getEntry(sessionId);
    if (entry) {
      setBusyStatus(sessionId, entry.session.directory, { type: 'idle' });
    }
    return true;
  };

  const updateSession = async (input = {}) => {
    const entry = await getEntry(input.sessionID);
    if (!entry) {
      throw new Error('Session not found');
    }

    const archivedAt = typeof input?.time?.archived === 'number' ? input.time.archived : null;
    const shouldArchive = typeof archivedAt === 'number';
    const requestedTitle = typeof input.title === 'string' ? input.title.trim() : null;

    if (requestedTitle !== null && requestedTitle !== entry.session.title) {
      try {
        await appServer.setThreadName(input.sessionID, requestedTitle, {
          directory: entry.session.directory,
          threadId: entry.threadId,
        });
      } catch (error) {
        console.warn(`[codex-backend] thread/name/set failed for ${input.sessionID}: ${error?.message || error}`);
      }
    }

    if (shouldArchive) {
      try {
        await appServer.archiveThread(input.sessionID, {
          directory: entry.session.directory,
          threadId: entry.threadId,
        });
      } catch (error) {
        console.warn(`[codex-backend] thread/archive failed for ${input.sessionID}: ${error?.message || error}`);
      }
    }

    const nextEntry = {
      ...entry,
      session: {
        ...entry.session,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        time: {
          ...entry.session.time,
          updated: Date.now(),
          ...(archivedAt ? { archived: archivedAt } : {}),
        },
      },
    };

    await saveEntry(nextEntry);
    emitSessionUpdate('session.updated', nextEntry.session);
    return { ...nextEntry.session };
  };

  const deleteSession = async (input = {}) => {
    await ensureLoaded();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID : '';
    const entry = sessions.get(sessionId);
    if (!entry) {
      return false;
    }

    // Best-effort Codex lifecycle cleanup before local deletion
    await appServer.archiveThread(sessionId, {
      directory: entry.session.directory,
      threadId: entry.threadId,
    }).catch(() => {});
    await appServer.unsubscribeThread(sessionId, {
      directory: entry.session.directory,
      threadId: entry.threadId,
    }).catch(() => {});
    await appServer.shutdownSession(sessionId).catch(() => {});

    sessions.delete(sessionId);
    await persist();
    emitEvent(entry.session.directory, {
      type: 'session.deleted',
      properties: {
        info: entry.session,
        directory: entry.session.directory,
      },
    });
    return true;
  };

  const revertSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID : '';
    const messageId = typeof input.messageID === 'string' ? input.messageID : '';
    const entry = await getEntry(sessionId);
    if (!entry) {
      throw new Error('Session not found');
    }

    // Find how many turns to roll back.
    // Each user+assistant pair is one turn. We count how many user messages
    // exist at or after the revert point.
    const records = entry.records || [];
    const userMessagesAfter = records.filter(
      (r) => r.info?.role === 'user' && r.info?.id >= messageId,
    );
    const numTurns = userMessagesAfter.length;

    if (numTurns > 0) {
      // Roll back the Codex thread
      await appServer.rollbackTurns(sessionId, numTurns).catch((err) => {
        console.warn(`[codex-backend] thread/rollback failed: ${err?.message}`);
      });
    }

    // Remove records at and after the revert point from local persistence.
    // Do NOT set a revert marker — the records are permanently removed,
    // so new messages should display normally without being filtered.
    const keptRecords = records.filter((r) => r.info?.id < messageId);
    const nextEntry = {
      ...entry,
      records: keptRecords,
      session: {
        ...entry.session,
        time: {
          ...entry.session.time,
          updated: Date.now(),
        },
      },
    };
    // Ensure revert marker is cleared
    delete nextEntry.session.revert;
    await saveEntry(nextEntry);
    emitSessionUpdate('session.updated', nextEntry.session);
    return { ...nextEntry.session };
  };

  const getStatusSnapshot = async (input = {}) => {
    await ensureLoaded();
    const directory = normalizeDirectory(input.directory);
    const result = {};
    for (const [sessionId, controller] of runControllers) {
      if (!controller) {
        continue;
      }
      const entry = sessions.get(sessionId);
      if (!entry) {
        continue;
      }
      if (directory && entry.session.directory !== directory) {
        continue;
      }
      result[sessionId] = { type: 'busy' };
    }
    return result;
  };

  const addEventClient = (res, directory) => {
    const client = { res, directory: normalizeDirectory(directory) };
    eventClients.add(client);
    const remove = () => {
      eventClients.delete(client);
    };
    res.on('close', remove);
    return () => {
      res.off('close', remove);
      remove();
    };
  };

  const getControlSurface = async () => {
    const customPromptCommands = await loadCustomPromptCommands();
    const modelOptions = await appServer.listModels();
    if (modelOptions.length === 0) {
      throw new Error('Codex model list is empty. Ensure the Codex CLI is installed and authenticated.');
    }
    const defaultModelId = modelOptions.find((option) => option.isDefault)?.id || modelOptions[0].id;

    const effortOptionDescriptor = {
      id: 'effort',
      label: 'Thinking',
      type: 'select',
      currentValue: DEFAULT_EFFORT_ID,
      options: EFFORT_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        isDefault: option.id === DEFAULT_EFFORT_ID,
      })),
    };
    const interactionModes = Object.values(MODE_DEFINITIONS).map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      isDefault: mode.id === DEFAULT_MODE_ID,
    }));
    const commands = [
      ...COMMAND_OPTIONS.map((command) => ({
        id: command.name,
        label: command.name,
        ...(command.description ? { description: command.description } : {}),
        raw: command,
      })),
      ...customPromptCommands.map((command) => ({
        id: command.name,
        label: command.name,
        ...(command.description ? { description: command.description } : {}),
        raw: command,
      })),
    ];

    return {
      backendId: 'codex',
      providerSnapshot: {
        backendId: 'codex',
        label: 'Codex',
        enabled: true,
        auth: { status: 'unknown' },
        capabilities: {
          chat: true,
          sessions: true,
          models: true,
          commands: true,
          providers: false,
          auth: false,
          config: true,
          skills: true,
          shell: false,
        },
        models: modelOptions.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          default: option.id === defaultModelId,
          optionDescriptors: [{ ...effortOptionDescriptor }],
          raw: option,
        })),
        interactionModes,
        commands,
      },
      modeSelector: {
        kind: 'mode',
        label: 'Mode',
        items: interactionModes,
      },
      modelSelector: {
        label: 'Model',
        source: 'provider-snapshot',
        providerId: 'codex',
        defaultOptionId: defaultModelId,
        options: modelOptions.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
      },
      effortSelector: {
        label: 'Thinking',
        source: 'provider-option',
        optionId: 'effort',
        defaultOptionId: DEFAULT_EFFORT_ID,
        options: EFFORT_OPTIONS.map((option) => ({ ...option })),
      },
      commandSelector: {
        source: 'backend',
        items: [
          ...COMMAND_OPTIONS.map((command) => ({
            ...command,
            executionMode: 'prompt-text',
          })),
          ...customPromptCommands,
        ],
      },
    };
  };

  // --- Permission / Question delegation to app-server adapter ---
  const hasPermissionRequest = (requestId) => appServer.hasPermissionRequest(requestId);
  const hasQuestionRequest = (requestId) => appServer.hasQuestionRequest(requestId);
  const replyToPermission = (requestId, reply) => appServer.replyToPermission(requestId, reply);
  const replyToQuestion = (requestId, answers) => appServer.replyToQuestion(requestId, answers);
  const rejectQuestion = (requestId) => appServer.rejectQuestion(requestId);
  const listPendingPermissions = (sessionId) => appServer.listPendingPermissions(sessionId);
  const listPendingQuestions = (sessionId) => appServer.listPendingQuestions(sessionId);
  const shutdownAll = () => appServer.shutdownAll();
  const isAvailable = () => appServer.isAvailable();

  return {
    ensureLoaded,
    listSessions,
    createSession,
    forkSession,
    getSession,
    getMessages,
    promptAsync,
    abortSession,
    updateSession,
    revertSession,
    deleteSession,
    getStatusSnapshot,
    addEventClient,
    getControlSurface,
    // Permission/question support
    hasPermissionRequest,
    hasQuestionRequest,
    replyToPermission,
    replyToQuestion,
    rejectQuestion,
    listPendingPermissions,
    listPendingQuestions,
    shutdownAll,
    isAvailable,
  };
};
