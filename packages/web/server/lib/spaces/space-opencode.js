// The one place that knows OpenCode's own formats inside a space, so an OpenCode format change is
// a one-file edit (DESIGN.md, "Parts"). Today: the provider configuration that sends a provider's
// model calls through the gatekeeper's window, and since 5e-2 a chat taken out of a space for the
// host's archive. The login record for the short OpenAI token belongs here too, in its stage.
//
// What is written here cooperates and enforces nothing. The agent can change or delete the file;
// the gatekeeper is what keeps the key out of the space and the space away from the internet.
//
// A chat taken out is untrusted data, like everything from a space: its record is rebuilt from a
// few checked fields, and the messages go to the host's OpenCode, whose import checks their shape.

import { z } from 'zod';

import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { IMAGE_ONLY_PATH, IMAGE_SH, SPACE_OPENCODE_CONFIG_DIRECTORY, SPACE_OPENCODE_CONFIG_PATH, spaceWindowUrl } from './layout.js';

// OpenCode takes a key from this option and its auth plugins stay out of the way; the window
// throws it away and puts the real one in its place. It is not a secret and never was one.
export const WINDOW_PLACEHOLDER_KEY = 'space-window';

// Through a temporary name, so OpenCode never reads half a file. The configuration is JSON on
// stdin: nothing of it is an argument.
const WRITE_CONFIG_SCRIPT = [
  IMAGE_ONLY_PATH,
  `mkdir -p ${SPACE_OPENCODE_CONFIG_DIRECTORY}`,
  `&& cat > ${SPACE_OPENCODE_CONFIG_PATH}.new && mv ${SPACE_OPENCODE_CONFIG_PATH}.new ${SPACE_OPENCODE_CONFIG_PATH}`,
].join(' ');

/**
 * OpenCode's global configuration for a space with these model grants: each provider, under the
 * id the host's catalog gives it, with its base URL at the window and a placeholder key. The
 * composer offers the host's catalog, and the same provider id inside is what makes that choice
 * work in the space unchanged. Decided with the maintainer on 2026-09-26.
 */
export function buildProviderConfig(grants) {
  const provider = {};
  for (const grant of grants) {
    if (grant.kind !== 'model') continue;
    provider[grant.provider] = { options: { baseURL: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY } };
  }
  return { $schema: 'https://opencode.ai/config.json', provider };
}

// A chat larger than this is not taken out: the host reads one chat into memory at a time, and a
// space can answer with as much as it likes. The maintainer's call of 2026-09-30; the largest chat
// measured on a real OpenCode was 94 MB.
const CHAT_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
// A chat that has not come whole in this time is not taken out, however slowly the space keeps
// sending: a space must not hold its own delete.
const CHAT_EXPORT_TIMEOUT_MS = 5 * 60_000;

// OpenCode's session id, checked before it goes into a path.
export const chatIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{1,64}$/);

const instantSchema = z.number().int().nonnegative();
const countSchema = z.number().nonnegative();

// What the host takes of a chat's record. Everything else the space says about it, its permissions,
// metadata, agent, model and revert among them, is dropped: an archive is read and never run.
const exportedInfoSchema = z.object({
  id: chatIdSchema,
  parentID: chatIdSchema.optional(),
  projectID: z.string().min(1).max(256),
  cost: countSchema,
  tokens: z.object({
    input: countSchema,
    output: countSchema,
    reasoning: countSchema,
    cache: z.object({ read: countSchema, write: countSchema }),
  }),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  time: z.object({ created: instantSchema, updated: instantSchema, idle: instantSchema.optional() }),
  title: z.string().max(4096).optional(),
});

// The messages travel whole; the host's OpenCode checks each one against its own schema on import.
const exportedChatSchema = z.object({
  data: z.object({
    info: exportedInfoSchema,
    messages: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough()),
  }),
});

/**
 * Reads an answer from inside up to `cap` bytes and until `deadline`; a longer one is
 * `chat_too_large`, a slower one `chat_export_timed_out`.
 */
const readCapped = (response, cap, timeoutMs) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  const fail = (error) => {
    clearTimeout(timer);
    response.destroy();
    reject(error);
  };
  const timer = setTimeout(() => fail(new SpaceError('chat_export_timed_out', `The chat did not come whole in ${timeoutMs} ms`)), timeoutMs);
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > cap) {
      fail(new SpaceError('chat_too_large', `The chat is larger than ${cap} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    clearTimeout(timer);
    resolve(Buffer.concat(chunks));
  });
  response.on('error', (error) => fail(error));
});

// Every tool of every agent refused in an archived chat, by OpenCode itself. The chat lives in the
// host's OpenCode, which VS Code, the OpenCode CLI and any other client reach without OpenChamber's
// server; a turn someone starts there anyway runs no tool on the host. OpenCode takes the last
// rule that matches, and a session's rules come after the agent's.
const ARCHIVED_CHAT_PERMISSIONS = Object.freeze([Object.freeze({ action: '*', resource: '*', effect: 'deny' })]);

/**
 * What the host's OpenCode imports for a chat of a deleted space: the checked record at the
 * archive's own directory, stamped archived, with every tool refused, and with `parentID` only
 * when the parent is in the same archive, so a space cannot hang its chat under a session of the
 * host's.
 */
export function archivedChatOf({ info, messages }, { directory, archivedAt, keepParent }) {
  const time = { created: info.time.created, updated: info.time.updated, archived: archivedAt };
  if (info.time.idle !== undefined) time.idle = info.time.idle;
  const record = {
    id: info.id,
    projectID: info.projectID,
    cost: info.cost,
    tokens: info.tokens,
    time,
    location: { directory },
    permissions: ARCHIVED_CHAT_PERMISSIONS,
  };
  if (info.parentID && keepParent) record.parentID = info.parentID;
  if (info.outcome) record.outcome = info.outcome;
  if (info.title !== undefined) record.title = info.title;
  return { info: record, messages, location: { directory } };
}

/**
 * `exec` is the place operation, always for the space container. `requestInside` is the
 * dispatcher's own request to the server inside, which a chat is taken out through, and
 * `chatMaxBytes` and `chatTimeoutMs` the caps on one chat, smaller in the tests.
 */
export function createSpaceOpenCode({ exec, requestInside, chatMaxBytes = CHAT_EXPORT_MAX_BYTES, chatTimeoutMs = CHAT_EXPORT_TIMEOUT_MS }) {
  /** Writes the whole global configuration from the model grants the record holds. */
  const writeProviderConfig = async (spaceId, grants) => {
    const text = `${JSON.stringify(buildProviderConfig(grants), null, 2)}\n`;
    const result = await exec(spaceId, [IMAGE_SH, '-c', WRITE_CONFIG_SCRIPT], { stdin: text });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not write the provider configuration inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

  /**
   * One chat of a space as OpenCode exports it, checked: `{ info, messages }`. A chat over the cap
   * is `chat_too_large`; anything else that does not come whole is `chat_export_failed`.
   */
  const exportChat = async (spaceId, chatId) => {
    const id = chatIdSchema.parse(chatId);
    const response = await requestInside(spaceId, {
      path: `/api/experimental/session/${id}/export`,
      headers: { accept: 'application/json' },
      timeoutMs: chatTimeoutMs,
    });
    if (response.statusCode !== 200) {
      response.resume();
      throw new SpaceError('chat_export_failed', `The space answered ${response.statusCode} for chat ${id}`);
    }
    const body = await readCapped(response, chatMaxBytes, chatTimeoutMs);
    let parsed;
    try {
      parsed = exportedChatSchema.safeParse(JSON.parse(body.toString('utf8')));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success || parsed.data.data.info.id !== id) throw new SpaceError('chat_export_failed', `The space did not give chat ${id} whole`);
    return parsed.data.data;
  };

  return { writeProviderConfig, exportChat };
}
