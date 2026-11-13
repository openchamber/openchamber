// Lighter message pages for clients that ask for them.
//
// A session page carries every finished tool call with its full result, and
// results (file reads, shell output, skill bodies) are most of a page's bytes
// while the transcript shows them only when a row is expanded. A client that
// sends PART_SHELLS_HEADER gets each finished call's result content replaced
// by a marker in its metadata; it fetches the message by id when a row needs
// the result. Fields no client reads (provider replay state, raw finish
// reasons, revert snapshots) are dropped from the same pages.
//
// Only the message list is shelled. `GET /api/session/:id/message/:messageID`
// always returns whole messages, so a shelled call can be completed from it.
// A client that does not send the header gets OpenCode's response unchanged.

/**
 * Request header: `v1`, then the names of tools whose results stay whole
 * (comma separated), e.g. `v1,shell`. A client lists the tools it shows
 * expanded without a click.
 */
export const PART_SHELLS_HEADER = 'x-openchamber-part-shells';

/** Metadata key marking a call whose result content was left out. */
export const CONTENT_SHELL_METADATA_KEY = 'openchamberContentShell';

// A subagent call's result names its child session for older OpenCode
// versions, which the transcript reads without expanding the row. File edits
// keep their diff in metadata and return a line of text, so leaving it out
// would save nothing and make expanding a diff wait for the network.
const ALWAYS_WHOLE_TOOLS = new Set(['subagent', 'task', 'edit', 'write', 'patch']);

/** Parses the header into the set of tools kept whole, or null when absent or not v1. */
export const parsePartShellsHeader = (value) => {
  if (typeof value !== 'string') return null;
  const [version, ...tools] = value.split(',').map((token) => token.trim());
  if (version !== 'v1') return null;
  return new Set(tools.filter(Boolean));
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const textLength = (content) => {
  let chars = 0;
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') chars += item.text.length;
  }
  return chars;
};

const shellTool = (part, keepWhole) => {
  const { native: _native, ...tool } = part;
  const state = tool.state;
  if (!isRecord(state) || (state.status !== 'completed' && state.status !== 'error')) return tool;
  if (keepWhole.has(tool.name) || ALWAYS_WHOLE_TOOLS.has(tool.name)) return tool;
  const content = Array.isArray(state.content) ? state.content : [];
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  // `metadata.output` repeats a shell's output for the running view.
  const { output: _output, ...keptMetadata } = metadata;
  if (content.length === 0 && _output === undefined) return tool;
  return {
    ...tool,
    state: {
      ...state,
      // OpenCode's contract has at least one content item on a finished call.
      content: [{ type: 'text', text: '' }],
      metadata: { ...keptMetadata, [CONTENT_SHELL_METADATA_KEY]: { chars: textLength(content) } },
    },
  };
};

const shellPart = (part, keepWhole) => {
  if (!isRecord(part)) return part;
  if (part.type === 'tool') return shellTool(part, keepWhole);
  if ((part.type === 'reasoning' || part.type === 'text') && 'native' in part) {
    // Provider replay data (encrypted reasoning, response ids); the client never reads it.
    const { native: _native, ...rest } = part;
    return rest;
  }
  return part;
};

const shellMessage = (message, keepWhole) => {
  if (!isRecord(message)) return message;
  const { native: _native, rawFinish: _rawFinish, snapshot: _snapshot, ...kept } = message;
  if (!Array.isArray(kept.content)) return kept;
  return { ...kept, content: kept.content.map((part) => shellPart(part, keepWhole)) };
};

/**
 * Returns the page with finished tool results shelled and unread fields
 * dropped, or the payload unchanged when it is not a message page.
 */
export const shellMessagePage = (payload, keepWhole) => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return payload;
  return { ...payload, data: payload.data.map((message) => shellMessage(message, keepWhole)) };
};
