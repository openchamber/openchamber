import { describe, expect, it, beforeEach } from 'bun:test';
import {
  buildTurnAbortEvents,
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

describe('tool arguments survive completion', () => {
  it('echoes the tool_use input on the completed state', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'Read',
          input: { file_path: '/proj/a.ts' },
        }],
      },
    });

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });

    const state = events.at(-1).properties.part.state;
    expect(state.status).toBe('completed');
    // The UI reducer replaces state wholesale — dropping input blanks the args.
    expect(state.input).toEqual({ file_path: '/proj/a.ts' });
  });
});

describe('extended thinking', () => {
  it('maps thinking deltas to a reasoning part', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'weighing options' },
      },
    });

    const opened = events.find((e) => e.type === 'message.part.updated');
    expect(opened.properties.part.type).toBe('reasoning');
    expect(events.at(-1)).toMatchObject({
      type: 'message.part.delta',
      properties: { delta: 'weighing options' },
    });
  });

  it('finalizes reasoning before text on result', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    });

    const { events } = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    const finals = events
      .filter((e) => e.type === 'message.part.updated')
      .map((e) => [e.properties.part.type, e.properties.part.text]);
    expect(finals).toEqual([['reasoning', 'hmm'], ['text', 'answer']]);
  });

  it('maps Claude result usage into assistant.info.tokens for goal budgets', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
      textPartId: 'prt_text',
      accumulatedText: 'done',
      textPartStarted: true,
    });

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 5,
      },
    });

    const completed = events.find((e) => (
      e.type === 'message.updated' && e.properties?.info?.role === 'assistant' && e.properties.info.finish === 'stop'
    ));
    expect(completed.properties.info.tokens).toEqual({
      input: 120,
      output: 40,
      reasoning: 0,
      cache: { read: 15, write: 5 },
    });
    expect(completed.properties.info.cost).toBe(0.0123);
  });
});

describe('divergent full text block', () => {
  it('rewrites the segment instead of dropping the tail', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
      textPartId: 'prt_text',
      accumulatedText: 'strea',
      textPartStarted: true,
    });

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'completely different answer' }] },
    });

    expect(events.at(-1).properties.part).toMatchObject({
      id: 'prt_text',
      type: 'text',
      text: 'completely different answer',
    });
  });
});

describe('abort finalization', () => {
  it('closes running tool parts and the open text segment', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
    });

    const events = buildTurnAbortEvents(ctx);
    const parts = events.map((e) => e.properties.part);

    expect(parts.find((p) => p.type === 'text')?.text).toBe('working');
    const tool = parts.find((p) => p.type === 'tool');
    expect(tool.state).toMatchObject({
      status: 'error',
      error: 'Aborted by user',
      input: { command: 'ls' },
    });
  });

  it('leaves already-settled tools alone', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    });

    expect(buildTurnAbortEvents(ctx)).toEqual([]);
  });
});

describe('from-claude slash / mcp / subagents', () => {
  beforeEach(() => {
    resetOpenCodeIdState();
  });

  it('extracts system/init capabilities without emitting transcript events', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    const { events, capabilities, foreignSessionId } = mapClaudeMessageToEvents(ctx, {
      type: 'system',
      subtype: 'init',
      session_id: 'foreign_1',
      slash_commands: ['compact', 'usage'],
      skills: ['pdf'],
      agents: ['explorer'],
      tools: ['Read', 'Agent'],
      mcp_servers: [{ name: 'fs', status: 'connected' }],
    });
    expect(events).toEqual([]);
    expect(foreignSessionId).toBe('foreign_1');
    expect(capabilities).toMatchObject({
      slash_commands: ['compact', 'usage'],
      skills: ['pdf'],
      agents: ['explorer'],
      mcp_servers: [{ name: 'fs', status: 'connected' }],
    });
  });

  it('creates a child session when Claude Agent tool starts', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_parent',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'agent_call_1',
          name: 'Agent',
          input: { description: 'Review auth', prompt: 'review auth' },
        }],
      },
    });
    const created = events.find((e) => e.type === 'session.created');
    expect(created?.properties.info.parentID).toBe('ses_parent');
    expect(created?.properties.info.title).toBe('Review auth');
    const tool = events.find((e) => e.properties?.part?.type === 'tool');
    expect(tool?.properties.part.state.metadata.sessionId).toBe(created?.properties.info.id);
  });

  it('routes parent_tool_use_id messages into the child session', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_parent',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    const start = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'agent_call_1',
          name: 'Agent',
          input: { description: 'Explore' },
        }],
      },
    });
    const childId = start.events.find((e) => e.type === 'session.created')?.properties.info.id;
    const nested = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      parent_tool_use_id: 'agent_call_1',
      message: {
        content: [{ type: 'text', text: 'looking around' }],
      },
    });
    const textPart = nested.events.find((e) => e.properties?.part?.type === 'text');
    expect(textPart?.properties.part.sessionID).toBe(childId);
    const delta = nested.events.find((e) => e.type === 'message.part.delta');
    expect(delta?.properties.sessionID).toBe(childId);
    expect(delta?.properties.delta).toBe('looking around');
  });
});
