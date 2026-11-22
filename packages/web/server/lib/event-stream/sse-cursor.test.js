import { describe, expect, it } from 'vitest';

import { createSseCursor, decodeOpenChamberCursor, encodeOpenChamberCursor, isOpenChamberCursor, isOpenCodeEventId, isResyncBlock, parseSseBlock, SSE_CURSOR_MAX_PENDING_CHARS } from './sse-cursor.js';

describe('SSE cursor', () => {
  it('tracks the id of the last complete block and reports every block in order', () => {
    const cursor = createSseCursor();

    const blocks = cursor.observe('id: ws:1\ndata: {"n":1}\n\nid: ws:2\ndata: {"n":2}\n\n');

    expect(blocks.map((block) => [block.id, block.data])).toEqual([
      ['ws:1', '{"n":1}'],
      ['ws:2', '{"n":2}'],
    ]);
    expect(cursor.lastEventId()).toBe('ws:2');
  });

  it('holds a block that is split across chunks until its boundary arrives', () => {
    const cursor = createSseCursor('ws:0');

    expect(cursor.observe('id: ws:1\ndata: {"n"')).toEqual([]);
    expect(cursor.lastEventId()).toBe('ws:0');

    const blocks = cursor.observe(':1}\n\n');
    expect(blocks.map((block) => block.data)).toEqual(['{"n":1}']);
    expect(cursor.lastEventId()).toBe('ws:1');
  });

  it('does not move the cursor on a block without an id, such as a heartbeat comment', () => {
    const cursor = createSseCursor('ws:4');

    cursor.observe(':heartbeat\n\ndata: {"n":5}\n\n');

    expect(cursor.lastEventId()).toBe('ws:4');
  });

  it('joins a CRLF pair split across chunks, so a boundary is not missed', () => {
    const cursor = createSseCursor();

    cursor.observe('id: ws:1\r\ndata: x\r');
    const blocks = cursor.observe('\n\r\n');

    expect(blocks).toHaveLength(1);
    expect(cursor.lastEventId()).toBe('ws:1');
  });

  it('clears the cursor on an empty id, as the SSE spec does', () => {
    const cursor = createSseCursor('ws:3');

    cursor.observe('id:\ndata: reset\n\n');

    expect(cursor.lastEventId()).toBe('');
  });

  it('restarts the cursor from the head id that OpenCode puts on its server.resync frame', () => {
    const cursor = createSseCursor('inst1:9');

    const [block] = cursor.observe('id: inst2:0\ndata: {"id":"evt_1","type":"server.resync","data":{}}\n\n');

    expect(block.resync).toBe(true);
    expect(cursor.lastEventId()).toBe('inst2:0');
  });

  it('restarts the cursor from nothing when a resync frame carries no id', () => {
    const cursor = createSseCursor('ws:3');

    const [block] = cursor.observe('data: {"type":"server.resync","data":{}}\n\n');

    expect(block.resync).toBe(true);
    expect(cursor.lastEventId()).toBe('');
  });

  it('discards an oversized block through its separator without corrupting the cursor', () => {
    const cursor = createSseCursor('ws:0', { maxPendingChars: 16 });

    expect(cursor.observe('data: {"forged":"')).toEqual([]);
    expect(cursor.lastEventId()).toBe('ws:0');

    // The remainder of the same oversized block: the `id:` line inside it belongs to the
    // discarded block, so it must not move the cursor, and its terminating separator is
    // consumed by the discard rather than closing a block.
    expect(cursor.observe('aaaa"\nid: forged\n\n')).toEqual([]);
    expect(cursor.lastEventId()).toBe('ws:0');

    const blocks = cursor.observe('id: ws:9\ndata: {"n":9}\n\n');
    expect(blocks.map((block) => [block.id, block.data])).toEqual([['ws:9', '{"n":9}']]);
    expect(cursor.lastEventId()).toBe('ws:9');
  });

  it('discards through a separator that is split across chunks', () => {
    const cursor = createSseCursor('ws:0', { maxPendingChars: 16 });

    expect(cursor.observe('x'.repeat(20))).toEqual([]);
    expect(cursor.observe('y\n')).toEqual([]);
    expect(cursor.observe('\n')).toEqual([]);
    expect(cursor.lastEventId()).toBe('ws:0');

    const blocks = cursor.observe('id: ws:5\ndata: {"n":5}\n\n');
    expect(blocks).toHaveLength(1);
    expect(cursor.lastEventId()).toBe('ws:5');
  });

  it('recovers through a CRLF separator split as CRLF + CR across chunks while discarding', () => {
    const cursor = createSseCursor('ws:0', { maxPendingChars: 16 });

    expect(cursor.observe('x'.repeat(20))).toEqual([]);
    // The oversized block's terminating separator arrives as \r\n\r, completed by the
    // leading \n of the next chunk. Retaining only the final \r would lose the preceding
    // \n, miss the separator, and discard the valid block that follows it.
    expect(cursor.observe('\r\n\r')).toEqual([]);
    const blocks = cursor.observe('\nid: ws:1\r\ndata: {}\r\n\r\n');
    expect(blocks.map((block) => [block.id, block.data])).toEqual([['ws:1', '{}']]);
    expect(cursor.lastEventId()).toBe('ws:1');
  });

  it('bounds pending at the default cap on a separator-less flood', () => {
    const cursor = createSseCursor();

    expect(cursor.observe('x'.repeat(SSE_CURSOR_MAX_PENDING_CHARS + 1))).toEqual([]);
    // Terminate the discarded flood block, then a genuine block parses normally.
    expect(cursor.observe('\n\n')).toEqual([]);

    const blocks = cursor.observe('id: ws:1\ndata: {"n":1}\n\n');
    expect(blocks).toHaveLength(1);
    expect(cursor.lastEventId()).toBe('ws:1');
  });

  it('starts from the id the browser already holds', () => {
    expect(createSseCursor('ws:7').lastEventId()).toBe('ws:7');
  });
});

describe('OpenChamber cursor', () => {
  const INSTANCE = '6b1f3c2e-8d4a-4f7b-9c3e-2a5d7e9f1b40';

  it('round-trips a stream position and its upstream OpenCode id', () => {
    const cursor = encodeOpenChamberCursor({ stream: 'global', position: 42, upstream: `${INSTANCE}:7` });
    expect(cursor).toBe(`occ1.global.42.${INSTANCE}:7`);
    expect(decodeOpenChamberCursor(cursor)).toEqual({
      version: 1,
      stream: 'global',
      position: 42,
      upstream: `${INSTANCE}:7`,
    });
  });

  it('round-trips a position with no upstream id yet', () => {
    expect(decodeOpenChamberCursor(encodeOpenChamberCursor({ stream: 'global', position: 0 })))
      .toEqual({ version: 1, stream: 'global', position: 0, upstream: '' });
  });

  it('cannot be mistaken for an OpenCode event id', () => {
    const cursor = encodeOpenChamberCursor({ stream: 'global', position: 3, upstream: `${INSTANCE}:9` });
    expect(isOpenCodeEventId(cursor)).toBe(false);
    expect(isOpenChamberCursor(cursor)).toBe(true);
    expect(isOpenChamberCursor(`${INSTANCE}:9`)).toBe(false);
  });

  it('rejects a wrong version, stream token, position or upstream form', () => {
    expect(decodeOpenChamberCursor(`occ2.global.1.${INSTANCE}:1`)).toBeNull();
    expect(decodeOpenChamberCursor('occ1.GLOBAL.1.')).toBeNull();
    expect(decodeOpenChamberCursor('occ1.global.-1.')).toBeNull();
    expect(decodeOpenChamberCursor('occ1.global.1.2')).toBeNull();
    expect(decodeOpenChamberCursor('occ1.global.1.not-an-id')).toBeNull();
    expect(decodeOpenChamberCursor('')).toBeNull();
    expect(decodeOpenChamberCursor(undefined)).toBeNull();
  });

  it('refuses to encode a cursor the decoder would reject', () => {
    expect(() => encodeOpenChamberCursor({ stream: 'global', position: -1 })).toThrow(TypeError);
    expect(() => encodeOpenChamberCursor({ stream: 'Global', position: 1 })).toThrow(TypeError);
    expect(() => encodeOpenChamberCursor({ stream: 'global', position: 1, upstream: 'nope' })).toThrow(TypeError);
  });
});

describe('SSE block parsing', () => {
  it('reads id, event and data fields, joining multi-line data', () => {
    expect(parseSseBlock('id: a:1\nevent: message\ndata: one\ndata: two')).toEqual({
      id: 'a:1',
      event: 'message',
      data: 'one\ntwo',
    });
  });

  it('recognises only the server.resync payload type, as OpenCode sends it', () => {
    expect(isResyncBlock({ event: undefined, data: '{"id":"evt_1","type":"server.resync","data":{}}' })).toBe(true);
    expect(isResyncBlock({ event: undefined, data: '{"type":"session.updated"}' })).toBe(false);
    expect(isResyncBlock({ event: undefined, data: '{"type":"server.resync_required"}' })).toBe(false);
    expect(isResyncBlock({ event: 'resync', data: '' })).toBe(false);
    expect(isResyncBlock({ event: undefined, data: 'server.resync but not JSON' })).toBe(false);
  });
});
