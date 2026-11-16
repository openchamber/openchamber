import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '@/lib/opencode/model';
import { opencodeCallSucceeded, opencodeToolVerb, parseOpencodeToolResult } from './opencodeToolResult';

const executePart = (callStatus: string): ToolPart => ({
  id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'opencode.session_rename', callID: 'call_1',
  state: {
    status: 'completed',
    input: { title: 'Voice models' },
    output: '{}',
    metadata: { toolCalls: [{ tool: 'opencode.session_rename', status: callStatus }] },
    time: { start: 1, end: 2 },
  },
});

describe('opencodeToolVerb', () => {
  test('names a namespace tool in either spelling, and nothing else', () => {
    expect(opencodeToolVerb('opencode.session_rename')?.key).toBe('chat.toolPart.opencode.action.sessionRename');
    expect(opencodeToolVerb('opencode_artifact_create')?.tool).toBe('artifact_create');
    expect(opencodeToolVerb('shell')).toBeNull();
  });
});

describe('opencodeCallSucceeded', () => {
  test('needs the call itself to succeed, not only the script around it', () => {
    expect(opencodeCallSucceeded(executePart('completed'))).toBe(true);
    expect(opencodeCallSucceeded(executePart('error'))).toBe(false);
  });
});

describe('parseOpencodeToolResult', () => {
  test("reads the tool's structured output, as is or quoted once more", () => {
    const output = JSON.stringify({ sessionID: 'ses_1', title: 'Voice models' });
    expect(parseOpencodeToolResult('session_rename', output)?.data).toEqual({ sessionID: 'ses_1', title: 'Voice models' });
    expect(parseOpencodeToolResult('session_rename', JSON.stringify(output))).not.toBeNull();
    const schedule = { id: 'sch_1', when: { type: 'every', every: '1 hour' }, tz: 'Europe/Kyiv', prompt: 'Check CI', status: 'active', runCount: 0 };
    expect(parseOpencodeToolResult('schedule_create', JSON.stringify(schedule))).not.toBeNull();
    const gated = { ...schedule, when: { type: 'every', every: '30 seconds' }, until: { type: 'shell', run: 'gh pr view 1 --json merged -q .merged', is: 'true' }, endsAt: '2026-11-09T11:00:00.000Z' };
    const read = parseOpencodeToolResult('schedule_create', JSON.stringify(gated));
    expect(read?.tool === 'schedule_create' ? read.data.until : undefined).toEqual({ type: 'shell', run: 'gh pr view 1 --json merged -q .merged' });
    expect(read?.tool === 'schedule_create' ? read.data.endsAt : undefined).toBe('2026-11-09T11:00:00.000Z');
    expect(parseOpencodeToolResult('worktree_list', JSON.stringify({ worktrees: [{ directory: '/repo', type: 'root' }] }))).not.toBeNull();
  });

  test('is null for whatever else a script returned', () => {
    expect(parseOpencodeToolResult('session_rename', 'Renamed.')).toBeNull();
    expect(parseOpencodeToolResult('session_rename', JSON.stringify({ title: 'no session' }))).toBeNull();
    expect(parseOpencodeToolResult('artifact_create', JSON.stringify({ id: 'art_1', title: 'Page', url: 'not a url' }))).toBeNull();
    expect(parseOpencodeToolResult('models', undefined)).toBeNull();
  });
});
