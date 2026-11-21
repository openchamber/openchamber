import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/opencode/model';
import { collectSubagentReports } from './useSubagentReports';

const assistant: Message = { id: 'a1', sessionID: 'parent', role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'p', modelID: 'm' };

const call = (childId: string, status: 'completed' | 'running', output: string): Part => ({
  id: `call-${childId}`,
  sessionID: 'parent',
  messageID: 'a1',
  type: 'tool',
  callID: `call-${childId}`,
  tool: 'subagent',
  state: { status: 'completed', input: { agent: 'build', description: 'look', prompt: 'p' }, output, metadata: { status, sessionID: childId }, time: { start: 1, end: 2 } },
});

describe('collectSubagentReports', () => {
  test('reads a foreground call, whose result is the report', () => {
    const reports = collectSubagentReports([assistant], { a1: [call('fg', 'completed', '<subagent sessionID="fg" state="completed">\n## Answer first\n</subagent>')] });
    expect(reports.get('fg')?.output).toBe('## Answer first');
    expect(reports.get('fg')?.state).toBe('completed');
  });

  test('takes a background report from its message, never from the call that started it', () => {
    const report: Message = {
      id: 'r1', sessionID: 'parent', role: 'synthetic', time: { created: 3 },
      text: '<subagent sessionID="bg" state="completed">\nDone\n</subagent>',
      metadata: { source: 'subagent', childID: 'bg', state: 'completed' },
    };
    const parts = { a1: [call('bg', 'running', 'The subagent is working in the background')] };
    expect(collectSubagentReports([assistant], parts).has('bg')).toBe(false);
    expect(collectSubagentReports([assistant, report], parts).get('bg')?.output).toBe('Done');
  });
});
