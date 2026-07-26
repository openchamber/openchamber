import { describe, expect, it, beforeEach } from 'bun:test';
import {
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
  mapClaudeMessageToEvents,
  resetOpenCodeIdState,
} from './from-claude.js';

describe('from-claude mapper', () => {
  beforeEach(() => {
    resetOpenCodeIdState();
  });

  it('emits user message.updated + text part + busy status', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      modelRef: 'sonnet',
    });
    const events = buildUserMessageEvents(ctx, 'hello');
    expect(events.map((e) => e.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'session.status',
    ]);
    expect(events[0].properties.info.role).toBe('user');
    expect(events[1].properties.part.text).toBe('hello');
    expect(events[2].properties.status.type).toBe('busy');
  });

  it('emits file parts for user attachments', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
    const events = buildUserMessageEvents(ctx, 'see image', [{
      mime: 'image/png',
      url: 'data:image/png;base64,aa==',
      filename: 'a.png',
    }]);
    const filePart = events.find((e) => e.properties?.part?.type === 'file');
    expect(filePart?.properties.part).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'a.png',
      messageID: 'msg_user',
    });
  });

  it('createOpenCodeId is ascending / lexicographically sortable', () => {
    const a = createOpenCodeId('prt');
    const b = createOpenCodeId('prt');
    const c = createOpenCodeId('prt');
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a.startsWith('prt_')).toBe(true);
  });

  it('maps stream text deltas to message.part.delta', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      textPartId: 'prt_text',
    });

    const first = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      session_id: 'foreign_1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi' },
      },
    });

    expect(first.foreignSessionId).toBe('foreign_1');
    expect(first.events.some((e) => e.type === 'message.part.delta')).toBe(true);
    const delta = first.events.find((e) => e.type === 'message.part.delta');
    expect(delta.properties).toMatchObject({
      messageID: 'msg_assistant',
      partID: 'prt_text',
      field: 'text',
      delta: 'Hi',
    });
  });

  it('maps tool_use and tool_result to tool parts and preserves tool name', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    const toolStart = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      session_id: 'foreign_1',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }],
      },
    });
    expect(toolStart.events.some((e) => e.type === 'message.part.updated')).toBe(true);
    const toolPart = toolStart.events.find((e) => e.properties?.part?.type === 'tool');
    expect(toolPart.properties.part.tool).toBe('Read');
    expect(toolPart.properties.part.state.status).toBe('running');

    const toolEnd = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      session_id: 'foreign_1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });
    const completed = toolEnd.events.find((e) => e.properties?.part?.type === 'tool');
    expect(completed.properties.part.state.status).toBe('completed');
    expect(completed.properties.part.tool).toBe('Read');
  });

  it('interleaves text → tool → text with ascending part ids (tools not below final reply)', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    const intro = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking…' } },
    });
    const introDelta = intro.events.find((e) => e.type === 'message.part.delta');
    const introPartId = introDelta.properties.partID;

    const tool = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    const toolPart = tool.events.find((e) => e.properties?.part?.type === 'tool');
    const toolPartId = toolPart.properties.part.id;

    mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });

    const outro = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
    });
    const outroDelta = outro.events.find((e) => e.type === 'message.part.delta');
    const outroPartId = outroDelta.properties.partID;

    // Distinct text segments around the tool.
    expect(outroPartId).not.toBe(introPartId);
    // Lexicographic / chronological order matches UI Binary.search part ordering.
    expect(introPartId < toolPartId).toBe(true);
    expect(toolPartId < outroPartId).toBe(true);
  });

  it('does not emit an empty text part on result when only tools ran', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }],
      },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      is_error: false,
    });

    const textParts = mapped.events.filter((e) => e.properties?.part?.type === 'text');
    expect(textParts).toEqual([]);
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
  });

  it('maps result to idle status and finalizes assistant message', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      textPartId: 'prt_text',
      accumulatedText: 'done',
      textPartStarted: true,
    });

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      session_id: 'foreign_1',
      result: 'done',
      is_error: false,
    });

    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
    expect(mapped.events.some((e) => e.type === 'message.updated' && e.properties.info.finish === 'stop')).toBe(true);
  });

  it('ignores unknown message types without throwing', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
    expect(mapClaudeMessageToEvents(ctx, { type: 'totally_unknown' }).events).toEqual([]);
    expect(mapClaudeMessageToEvents(ctx, null).events).toEqual([]);
  });
});
