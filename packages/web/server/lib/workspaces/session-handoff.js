import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 2;
const PAGE_SIZE = 100;
const MAX_MESSAGES = 10_000;
const MAX_DRAFT_CHARS = 64_000;
const MAX_OPERATIONS = 100;
const OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const STATES = new Set(['drafted', 'confirmed', 'target-created', 'context-inserted', 'verified', 'completed', 'cleanup-required']);
const WARNING_CODES = ['not-exact-history', 'excluded-content', 'file-changes-excluded'];

const fail = (message, statusCode = 409, details) => Object.assign(new Error(message), { statusCode, ...details });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const bodyHash = (value) => sha256(JSON.stringify(canonical(value)));
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sdkData = (result, label) => {
  if (result?.error || result?.data === undefined) throw fail(`${label} failed`, result?.response?.status || 502);
  return result.data;
};

function hasCredentialLikeContent(text) {
  return /(?:data:[^\s;,]+;base64,|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*\S{6,}|\b(?:sk|gh[opusr])_[A-Za-z0-9_-]{16,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i.test(text);
}

function omissionCode(part) {
  const type = typeof part?.type === 'string' ? part.type : 'unknown';
  return new Set(['reasoning', 'tool', 'file', 'subtask', 'agent', 'snapshot', 'patch', 'step-start', 'step-finish', 'retry', 'compaction']).has(type)
    ? type
    : 'unknown';
}

function goalText(session) {
  const goal = session?.metadata?.openchamber?.goal;
  if (!isRecord(goal)) return { text: '', omitted: false };
  if (goal.objectiveFile === true) return { text: '', omitted: true };
  const text = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  if (!text || hasCredentialLikeContent(text)) return { text: '', omitted: Boolean(text) };
  return { text: text.slice(0, 5_000), omitted: false };
}

function extractDraft(session, messages) {
  const omissions = {};
  const blocks = [];
  const goal = goalText(session);
  if (goal.text) blocks.push(`Session goal:\n${goal.text}`);
  if (goal.omitted) omissions.goal = 1;

  for (const message of messages) {
    const role = message?.info?.role;
    if (role !== 'user' && role !== 'assistant') {
      omissions.message = (omissions.message || 0) + 1;
      continue;
    }
    const visible = [];
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (part?.type !== 'text') {
        const code = omissionCode(part);
        omissions[code] = (omissions[code] || 0) + 1;
        continue;
      }
      const text = typeof part.text === 'string' ? part.text.trim() : '';
      if (!text || part.synthetic === true || part.ignored === true || hasCredentialLikeContent(text)) {
        omissions.text = (omissions.text || 0) + 1;
        continue;
      }
      visible.push(text);
    }
    if (visible.length) blocks.push(`${role === 'user' ? 'User' : 'Assistant'}:\n${visible.join('\n\n')}`);
  }

  const full = blocks.join('\n\n');
  let text = full;
  if (text.length > MAX_DRAFT_CHARS) {
    text = text.slice(text.length - MAX_DRAFT_CHARS);
    omissions.truncated = 1;
  }
  return {
    text,
    omissions: Object.entries(omissions).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    warningCodes: WARNING_CODES,
  };
}

async function loadCompleteMessages(client, session) {
  const records = [];
  const cursors = new Set();
  let before;
  while (true) {
    const result = await client.session.messages({
      sessionID: session.id,
      directory: session.directory,
      ...(session.workspaceID ? { workspace: session.workspaceID } : {}),
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    const page = sdkData(result, 'session.messages');
    if (!Array.isArray(page)) throw fail('OpenCode returned an invalid session message page', 502);
    records.push(...page);
    if (records.length > MAX_MESSAGES) throw fail('Source session is too large for a bounded handoff draft', 413);
    const cursor = result?.response?.headers?.get?.('x-next-cursor');
    if (!cursor) break;
    if (cursors.has(cursor)) throw fail('OpenCode message pagination did not make progress', 502);
    cursors.add(cursor);
    before = cursor;
  }
  records.sort((left, right) => (left?.info?.time?.created || 0) - (right?.info?.time?.created || 0) || String(left?.info?.id).localeCompare(String(right?.info?.id)));
  return records;
}

function sourceBoundary(messages) {
  const through = messages[messages.length - 1]?.info?.id ?? null;
  const hash = bodyHash(messages.map((message) => ({
    id: message?.info?.id,
    role: message?.info?.role,
    created: message?.info?.time?.created,
    parts: (Array.isArray(message?.parts) ? message.parts : []).map((part) => ({
      id: part?.id,
      type: part?.type,
      textHash: part?.type === 'text' && typeof part.text === 'string' ? sha256(part.text) : null,
      synthetic: part?.synthetic === true,
      ignored: part?.ignored === true,
    })),
  })));
  return { through, hash, count: messages.length };
}

async function atomicWrite(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  try {
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch {
    // Some filesystems do not support directory fsync.
  }
}

export class WorkspaceHandoffJournal {
  constructor({ rootDirectory, now = () => Date.now() }) {
    this.rootDirectory = rootDirectory;
    this.now = now;
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(rootDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw fail('Handoff operation journal root is unsafe', 500);
    fs.chmodSync(rootDirectory, 0o700);
    this.prune();
  }

  file(operationID) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationID)) throw fail('Invalid handoff operation ID', 400);
    return path.join(this.rootDirectory, `${operationID}.json`);
  }

  read(operationID) {
    const file = this.file(operationID);
    let parsed;
    let descriptor;
    try {
      const pathStat = fs.lstatSync(file);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw fail('Handoff operation journal is not a regular file', 500);
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
      if (!fs.fstatSync(descriptor).isFile()) throw fail('Handoff operation journal is not a regular file', 500);
      parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw fail('Handoff operation journal is unreadable', 500);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    if (parsed?.version !== VERSION || parsed.operationID !== operationID || !STATES.has(parsed.state)) throw fail('Handoff operation journal is invalid', 500);
    if (parsed.expiresAt <= this.now()) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return parsed;
  }

  async write(operation) {
    await atomicWrite(this.file(operation.operationID), operation);
    this.prune();
  }

  delete(operationID) {
    fs.rmSync(this.file(operationID), { force: true });
  }

  prune() {
    const entries = fs.readdirSync(this.rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]{16,128}\.json$/.test(entry.name))
      .map((entry) => ({ name: entry.name, stat: fs.statSync(path.join(this.rootDirectory, entry.name)) }))
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    for (const [index, entry] of entries.entries()) {
      const file = path.join(this.rootDirectory, entry.name);
      let legacy = false;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        legacy = parsed?.version !== VERSION || typeof parsed?.draft?.text === 'string' || Array.isArray(parsed?.draft?.warnings);
      } catch {
        // Current-format corruption remains available for an explicit read error.
      }
      if (legacy || index >= MAX_OPERATIONS || entry.stat.mtimeMs + OPERATION_TTL_MS <= this.now()) fs.rmSync(file, { force: true });
    }
  }
}

export function createWorkspaceSessionHandoff({ journal, createClient, persistedContext, loadWorkspace, workspaceStatus, randomID = () => crypto.randomUUID(), now = () => Date.now() }) {
  const operationQueues = new Map();
  async function serialize(operationID, task) {
    const previous = operationQueues.get(operationID) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    operationQueues.set(operationID, current);
    try { return await current; } finally {
      if (operationQueues.get(operationID) === current) operationQueues.delete(operationID);
    }
  }
  const principalOperation = (operation, principal) => {
    if (!operation) throw fail('Handoff operation not found', 404);
    if (operation.principal !== principal) throw fail('Handoff operation belongs to a different principal', 403);
    return operation;
  };

  async function authoritativeBinding(input) {
    const context = await persistedContext(input.directory || '', null);
    const client = await createClient(context.directory);
    const source = sdkData(await client.session.get({
      sessionID: input.sourceSessionID,
      directory: context.directory,
      ...(input.sourceWorkspaceID ? { workspace: input.sourceWorkspaceID } : {}),
    }), 'session.get');
    if (source.directory !== context.directory || source.projectID !== input.projectID) throw fail('Source session does not match the canonical project');
    if ((source.workspaceID ?? null) !== (input.sourceWorkspaceID ?? null)) throw fail('Source session workspace changed');
    if (source.workspaceID) {
      const sourceWorkspace = await loadWorkspace(source.workspaceID, context.directory);
      if (sourceWorkspace.projectID !== source.projectID || sourceWorkspace.directory !== context.directory) throw fail('Source workspace does not match the canonical project');
    }
    let target = null;
    if (input.targetWorkspaceID) {
      target = await loadWorkspace(input.targetWorkspaceID, context.directory);
      if (target.projectID !== source.projectID || target.directory !== context.directory) throw fail('Target workspace does not match the source project');
      const statuses = await workspaceStatus(client, context.directory);
      const status = statuses.find((item) => item?.workspaceID === target.id)?.status;
      if (status !== 'connected') throw fail('Target workspace is not connected');
    }
    const statuses = sdkData(await client.session.status({ directory: context.directory, ...(source.workspaceID ? { workspace: source.workspaceID } : {}) }), 'session.status');
    if (statuses?.[source.id] && statuses[source.id].type !== 'idle') throw fail('Source session must be authoritatively idle');
    return { context, client, source, target };
  }

  async function draft(input, principal) {
    const binding = await authoritativeBinding(input);
    const messages = await loadCompleteMessages(binding.client, binding.source);
    const boundary = sourceBoundary(messages);
    const extracted = extractDraft(binding.source, messages);
    const operationID = randomID();
    const draftID = randomID();
    const operation = {
      version: VERSION,
      operationID,
      principal,
      state: 'drafted',
      createdAt: now(),
      updatedAt: now(),
      expiresAt: now() + OPERATION_TTL_MS,
      draft: { id: draftID, revision: 1, hash: sha256(extracted.text), boundary, omissions: extracted.omissions },
      binding: {
        projectID: binding.source.projectID,
        directory: binding.context.directory,
        sourceSessionID: binding.source.id,
        sourceWorkspaceID: binding.source.workspaceID ?? null,
        targetWorkspaceID: binding.target?.id ?? null,
      },
      targetSessionID: null,
      targetRouteWorkspaceID: null,
      commitHash: null,
      contextMessageID: null,
      contextPartID: null,
    };
    await journal.write(operation);
    return publicOperation(operation, {
      draft: { ...operation.draft, text: extracted.text, warningCodes: extracted.warningCodes },
    });
  }

  function publicOperation(operation, ephemeral = {}) {
    return {
    operationID: operation.operationID,
    state: operation.state,
    binding: operation.binding,
    targetSessionID: operation.targetSessionID,
    cleanupRequired: operation.state === 'cleanup-required',
    ...(ephemeral.draft ? { draft: ephemeral.draft } : {}),
    };
  }

  async function findTarget(client, operation) {
    const routeWorkspaceID = operation.targetSessionID ? operation.targetRouteWorkspaceID : operation.binding.targetWorkspaceID;
    const matches = [];
    for (let start = 0; start < MAX_MESSAGES; start += PAGE_SIZE) {
      const response = sdkData(await client.session.list({
        directory: operation.binding.directory,
        ...(routeWorkspaceID ? { workspace: routeWorkspaceID } : {}),
        start,
        limit: PAGE_SIZE,
      }), 'session.list');
      if (!Array.isArray(response)) throw fail('OpenCode returned an invalid target session list', 502);
      matches.push(...response.filter((session) => session?.metadata?.openchamber?.handoffOperationID === operation.operationID));
      if (response.length < PAGE_SIZE) break;
      if (start + PAGE_SIZE >= MAX_MESSAGES) throw fail('Target session list is too large for bounded recovery', 413);
    }
    if (matches.length > 1) throw fail('Multiple target sessions claim this handoff operation', 409, { cleanupRequired: true });
    return matches[0] ?? null;
  }

  async function inspectContext(client, operation) {
    if (!operation.targetSessionID) return null;
    const matches = [];
    const cursors = new Set();
    let before;
    let count = 0;
    while (true) {
      const result = await client.session.messages({
        sessionID: operation.targetSessionID,
        directory: operation.binding.directory,
        ...(operation.targetRouteWorkspaceID ? { workspace: operation.targetRouteWorkspaceID } : {}),
        limit: PAGE_SIZE,
        ...(before ? { before } : {}),
      });
      const messages = sdkData(result, 'session.messages');
      if (!Array.isArray(messages)) throw fail('OpenCode returned an invalid target message page', 502);
      count += messages.length;
      if (count > MAX_MESSAGES) throw fail('Target session is too large for bounded handoff recovery', 413);
      matches.push(...messages.filter((message) => message?.info?.id === operation.contextMessageID));
      const cursor = result?.response?.headers?.get?.('x-next-cursor');
      if (!cursor) break;
      if (cursors.has(cursor)) throw fail('OpenCode target message pagination did not make progress', 502);
      cursors.add(cursor);
      before = cursor;
    }
    if (matches.length > 1) throw fail('Target contains duplicate handoff context messages');
    const match = matches[0];
    if (!match) return null;
    if (!Array.isArray(match.parts) || match.parts.length !== 1 || match.parts[0]?.type !== 'text' || match.parts[0]?.id !== operation.contextPartID) throw fail('Target handoff context payload is not text-only');
    return match;
  }

  async function removeTarget(client, operation) {
    if (!operation.targetSessionID) return true;
    try {
      sdkData(await client.session.delete({
        sessionID: operation.targetSessionID,
        directory: operation.binding.directory,
        ...(operation.targetRouteWorkspaceID ? { workspace: operation.targetRouteWorkspaceID } : {}),
      }), 'session.delete');
      const existing = await findTarget(client, operation);
      return !existing;
    } catch {
      return false;
    }
  }

  async function commitOperation(input, principal) {
    const operation = principalOperation(journal.read(input.operationID), principal);
    const bindingPayload = {
      projectID: input.projectID,
      directory: input.directory,
      sourceSessionID: input.sourceSessionID,
      sourceWorkspaceID: input.sourceWorkspaceID ?? null,
      targetWorkspaceID: input.targetWorkspaceID ?? null,
    };
    if (bodyHash(bindingPayload) !== bodyHash(operation.binding)) throw fail('Handoff binding does not match the reviewed draft');
    if (input.draftID !== operation.draft.id || input.draftRevision !== operation.draft.revision || input.draftHash !== operation.draft.hash) throw fail('Handoff draft revision does not match');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_DRAFT_CHARS || hasCredentialLikeContent(input.text)) throw fail('Edited handoff context is empty, too large, or contains credential-like content', 400);
    const commitHash = bodyHash({ ...bindingPayload, draftID: input.draftID, draftRevision: input.draftRevision, draftHash: input.draftHash, text: input.text });
    if (operation.commitHash && operation.commitHash !== commitHash) throw fail('Operation ID was already used with a different commit payload');
    if (operation.state === 'completed') return publicOperation(operation);
    if (operation.state === 'cleanup-required') throw fail('Target cleanup is required before this operation can continue', 409, { cleanupRequired: true });

    const binding = await authoritativeBinding(operation.binding);
    const currentMessages = await loadCompleteMessages(binding.client, binding.source);
    const currentBoundary = sourceBoundary(currentMessages);
    const currentDraft = extractDraft(binding.source, currentMessages);
    if (bodyHash(currentBoundary) !== bodyHash(operation.draft.boundary) || sha256(currentDraft.text) !== operation.draft.hash) {
      if (operation.targetSessionID) {
        if (await removeTarget(binding.client, operation)) {
          operation.targetSessionID = null;
          operation.targetRouteWorkspaceID = null;
          operation.state = 'confirmed';
        } else {
          operation.state = 'cleanup-required';
        }
        operation.updatedAt = now();
        await journal.write(operation);
      }
      throw fail('Source session changed after draft review; create and review a new draft', 409, { staleDraft: true, cleanupRequired: operation.state === 'cleanup-required' });
    }

    operation.commitHash = commitHash;
    operation.state = operation.state === 'drafted' ? 'confirmed' : operation.state;
    operation.updatedAt = now();
    await journal.write(operation);

    try {
      if (!operation.targetSessionID) {
        let target = await findTarget(binding.client, operation);
        if (!target) {
          try {
            target = sdkData(await binding.client.session.create({
              directory: operation.binding.directory,
              ...(operation.binding.targetWorkspaceID ? { workspace: operation.binding.targetWorkspaceID } : {}),
              metadata: { openchamber: { handoffOperationID: operation.operationID, sourceSessionID: operation.binding.sourceSessionID } },
            }), 'session.create');
          } catch (error) {
            target = await findTarget(binding.client, operation);
            if (!target) throw error;
          }
        }
        operation.targetSessionID = target.id;
        operation.targetRouteWorkspaceID = target.workspaceID ?? null;
        operation.state = 'target-created';
        operation.updatedAt = now();
        await journal.write(operation);
        if ((target.workspaceID ?? null) !== operation.binding.targetWorkspaceID || target.projectID !== operation.binding.projectID) throw fail('Created target session has incorrect routing');
      }

      operation.contextMessageID ||= `msg_handoff_${sha256(operation.operationID).slice(0, 24)}`;
      operation.contextPartID ||= `prt_handoff_${sha256(`${operation.operationID}:context`).slice(0, 24)}`;
      let inserted = await inspectContext(binding.client, operation);
      if (!inserted) {
        try {
          sdkData(await binding.client.session.prompt({
            sessionID: operation.targetSessionID,
            directory: operation.binding.directory,
            ...(operation.binding.targetWorkspaceID ? { workspace: operation.binding.targetWorkspaceID } : {}),
            messageID: operation.contextMessageID,
            noReply: true,
            parts: [{ id: operation.contextPartID, type: 'text', text: input.text }],
          }), 'session.prompt');
        } catch (error) {
          inserted = await inspectContext(binding.client, operation);
          if (!inserted) throw error;
        }
        inserted = await inspectContext(binding.client, operation);
      }
      operation.state = 'context-inserted';
      operation.updatedAt = now();
      await journal.write(operation);
      const insertedText = inserted?.parts?.[0]?.text;
      if (typeof insertedText !== 'string' || sha256(insertedText) !== sha256(input.text)) throw fail('Inserted handoff context did not verify exactly');
      operation.state = 'verified';
      operation.updatedAt = now();
      await journal.write(operation);
      operation.state = 'completed';
      operation.updatedAt = now();
      await journal.write(operation);
      return publicOperation(operation);
    } catch (error) {
      if (operation.state === 'confirmed') throw error;
      if (operation.state === 'target-created' && !await inspectContext(binding.client, operation).catch(() => null)) {
        if (await removeTarget(binding.client, operation)) {
          operation.targetSessionID = null;
          operation.targetRouteWorkspaceID = null;
          operation.state = 'confirmed';
          operation.updatedAt = now();
          await journal.write(operation);
          throw error;
        }
      }
      operation.state = 'cleanup-required';
      operation.updatedAt = now();
      await journal.write(operation);
      throw fail('Handoff failed and the newly created target requires explicit cleanup', 409, { cleanupRequired: true });
    }
  }

  async function commit(input, principal) {
    return serialize(input.operationID, () => commitOperation(input, principal));
  }

  async function inspect(operationID, principal) {
    return publicOperation(principalOperation(journal.read(operationID), principal));
  }

  async function cleanupOperation(operationID, principal) {
    const operation = principalOperation(journal.read(operationID), principal);
    const context = await persistedContext(operation.binding.directory, null);
    const client = await createClient(context.directory);
    if (!await removeTarget(client, operation)) throw fail('New target session could not be confirmed deleted', 409, { cleanupRequired: true });
    operation.targetSessionID = null;
    operation.targetRouteWorkspaceID = null;
    operation.state = 'confirmed';
    operation.updatedAt = now();
    await journal.write(operation);
    return publicOperation(operation);
  }

  async function cleanup(operationID, principal) {
    return serialize(operationID, () => cleanupOperation(operationID, principal));
  }

  return { draft, commit, inspect, cleanup };
}

export const workspaceHandoffInternals = { extractDraft, sourceBoundary, bodyHash, hasCredentialLikeContent };
