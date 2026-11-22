// The resume cursor of one proxied SSE stream: the `id:` of the last complete block the proxy
// forwarded. The id is opaque here. OpenCode decides what it means (`<instance>:<sequence>`, per
// packages/server/src/event-feed.ts), and OpenChamber only hands it back as Last-Event-ID when the
// upstream connection is re-established.
//
// Per the SSE spec an `id:` line sets the last event id, even to an empty value, so a block
// carrying an empty `id:` clears the cursor. A `server.resync` block says the cursor is no longer
// usable (OpenCode did not know the id, or it came from another instance): the client has to
// refetch. OpenCode sends it with the head id of its own feed, so the cursor restarts there.

export const SSE_RESYNC_PAYLOAD_TYPE = 'server.resync';

// OpenCode's wire form of an id: `<instance>:<sequence>`, with a random UUID per instance
// (packages/server/src/event-feed.ts). Only such a cursor can be replayed from upstream.
const OPENCODE_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i;

// An OpenChamber cursor names a position in one OpenChamber stream and the OpenCode id that
// position sits after. The `occ1.` prefix cannot collide with OpenCode's `<uuid>:<sequence>` form,
// and the stream token lets the server reject a cursor minted for another stream before replay.
const OPENCHAMBER_CURSOR_VERSION = 1;
const OPENCHAMBER_CURSOR_PATTERN = /^occ1\.([a-z0-9-]+)\.(0|[1-9]\d*)\.(.*)$/;

export function isOpenCodeEventId(id) {
  return OPENCODE_EVENT_ID.test(id ?? '');
}

/**
 * Encodes the position of one OpenChamber stream and the OpenCode cursor it sits after.
 * `position` counts state frames committed to the stream; `upstream` is empty until OpenCode
 * has sent an event with an id. Throws on inputs the decoder would reject, so the two functions
 * cannot drift into producing cursors that never resolve.
 */
export function encodeOpenChamberCursor({ stream, position, upstream = '' }) {
  if (!/^[a-z0-9-]+$/.test(`${stream ?? ''}`)) {
    throw new TypeError('OpenChamber cursor stream must be a lowercase token');
  }
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new TypeError('OpenChamber cursor position must be a nonnegative safe integer');
  }
  if (upstream !== '' && !isOpenCodeEventId(upstream)) {
    throw new TypeError('OpenChamber cursor upstream must be an OpenCode event id or empty');
  }
  return `occ1.${stream}.${position}.${upstream}`;
}

/** Decodes a versioned OpenChamber cursor, or returns null for anything else. */
export function decodeOpenChamberCursor(cursor) {
  const text = `${cursor ?? ''}`;
  const match = OPENCHAMBER_CURSOR_PATTERN.exec(text);
  if (!match) return null;
  const position = Number(match[2]);
  if (!Number.isSafeInteger(position)) return null;
  const upstream = match[3];
  if (upstream !== '' && !isOpenCodeEventId(upstream)) return null;
  return { version: OPENCHAMBER_CURSOR_VERSION, stream: match[1], position, upstream };
}

export function isOpenChamberCursor(cursor) {
  return decodeOpenChamberCursor(cursor) !== null;
}

export function parseSseBlock(block) {
  let id;
  let event;
  const data = [];
  for (const line of block.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'id') id = value;
    else if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  return { id, event, data: data.join('\n') };
}

export function isResyncBlock({ data }) {
  if (!data.includes(SSE_RESYNC_PAYLOAD_TYPE)) return false;
  try {
    return JSON.parse(data)?.type === SSE_RESYNC_PAYLOAD_TYPE;
  } catch {
    return false;
  }
}

// Cap on one partial (separator-less) SSE block retained between observe() calls. Same bound
// and reasoning as UPSTREAM_SSE_MAX_BUFFERED_CHARS in upstream-reader.js: complete blocks may be
// larger, but a stream that never sends the separator must not retain (and re-concatenate) a
// partial block without bound.
export const SSE_CURSOR_MAX_PENDING_CHARS = 4 * 1024 * 1024;

export function createSseCursor(initialLastEventId = '', { maxPendingChars = SSE_CURSOR_MAX_PENDING_CHARS } = {}) {
  let lastEventId = initialLastEventId;
  let pending = '';
  // After an overflow, the rest of the oversized block is still in flight and must be
  // discarded through its terminating separator, not parsed: its remaining lines are not a
  // new block, and an `id:` line inside it (e.g. inside a long data payload) would otherwise
  // be taken as a fresh block and corrupt the cursor. While discarding, only the trailing
  // separator prefix is retained: a normalized trailing `\n`, `\r`, or `\n\r` (a CRLF pair
  // split at its CR, after a completed CRLF line ending) can still complete a `\n\n`
  // separator with the next chunk, so dropping any of it would miss that separator.
  let discarding = false;
  let discardTail = '';
  // The suffix of a normalized string that could be the first half of a split separator.
  const separatorTail = (value) => {
    if (value.endsWith('\n\r')) return '\n\r';
    if (value.endsWith('\n') || value.endsWith('\r')) return value.slice(-1);
    return '';
  };

  return {
    lastEventId() {
      return lastEventId;
    },
    // Feeds decoded text and returns the complete blocks it closed, in stream order. Text that
    // does not end a block is held until the next call.
    observe(text) {
      let incoming = `${text}`;
      if (discarding) {
        const raw = `${discardTail}${incoming}`;
        const scan = raw.replace(/\r\n/g, '\n');
        const end = scan.indexOf('\n\n');
        if (end === -1) {
          discardTail = separatorTail(scan);
          return [];
        }
        discarding = false;
        discardTail = '';
        incoming = scan.slice(end + 2);
        if (incoming.length === 0) return [];
      }
      pending = `${pending}${incoming}`.replace(/\r\n/g, '\n');
      const blocks = [];
      for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
        const block = parseSseBlock(pending.slice(0, end));
        pending = pending.slice(end + 2);
        if (block.id !== undefined) lastEventId = block.id;
        const resync = isResyncBlock(block);
        if (resync && block.id === undefined) lastEventId = '';
        blocks.push({ ...block, resync });
      }
      if (pending.length > maxPendingChars) {
        // The retained partial block can never be trusted to complete within the cap, and the
        // cursor only advances on complete blocks, so dropping it loses no cursor state. The
        // discard continues through the block's terminating separator (see `discarding`
        // above): resuming parsing immediately would let the remainder of this same block
        // pose as a new block and corrupt the cursor.
        discarding = true;
        discardTail = separatorTail(pending);
        pending = '';
      }
      return blocks;
    },
  };
}
