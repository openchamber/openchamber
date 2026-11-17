import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, Part, ToolState } from '@/lib/opencode/model';
import { resolveLoadedSkillTarget, selectLoadedSkills } from './loadedSkills';

const sessionID = 'ses_1';

const assistant = (id: string): AssistantMessage => ({
  id, sessionID, role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'p', modelID: 'm',
});

const skillCall = (messageID: string, callID: string, state: ToolState): Part => ({
  id: `${messageID}:${callID}`, sessionID, messageID, type: 'tool', callID, tool: 'skill', state,
});

const completed = (id: string, metadata: Record<string, string>): ToolState => ({
  status: 'completed', input: { id }, output: '<skill_content/>', metadata, time: { start: 1, end: 2 },
});

describe('selectLoadedSkills', () => {
  test('lists each skill once, where it first loaded, from every way a skill loads', () => {
    const messages: Message[] = [
      { id: 'u1', sessionID, role: 'user', time: { created: 1 }, skills: [{ id: 'attached', name: 'attached' }] },
      assistant('a1'),
      { id: 's1', sessionID, role: 'skill', time: { created: 3 }, skill: 'activated', name: 'Activated', text: '' },
      assistant('a2'),
    ];
    const parts = {
      a1: [
        skillCall('a1', 'c1', completed('demo', { name: 'demo', directory: '/p/.opencode/skills/demo' })),
        skillCall('a1', 'c2', completed('attached', { name: 'attached', directory: '/p/.opencode/skills/attached' })),
      ],
      a2: [skillCall('a2', 'c3', completed('demo', { name: 'demo', directory: '/p/.opencode/skills/demo' }))],
    } satisfies Record<string, Part[]>;

    const loaded = selectLoadedSkills(messages, parts);
    expect(loaded.map((skill) => skill.id)).toEqual(['attached', 'demo', 'activated']);
    expect(loaded[2]).toEqual({ id: 'activated', name: 'Activated' });
  });

  test('a skill attached first still opens from the folder a later call reported', () => {
    const messages: Message[] = [
      { id: 'u1', sessionID, role: 'user', time: { created: 1 }, skills: [{ id: 'attached', name: 'attached' }] },
      assistant('a1'),
    ];
    const parts = {
      a1: [skillCall('a1', 'c1', completed('attached', { name: 'attached', directory: '/p/.opencode/skills/attached' }))],
    } satisfies Record<string, Part[]>;
    // The skills list has not been read, so only the call names the file.
    const [attached] = selectLoadedSkills(messages, parts);
    expect(resolveLoadedSkillTarget(attached, [])).toEqual({ kind: 'file', path: '/p/.opencode/skills/attached/SKILL.md' });
  });

  test('a call that has not completed loaded nothing', () => {
    const parts = {
      a1: [
        skillCall('a1', 'pending', { status: 'pending', input: { id: 'pending' }, raw: '' }),
        skillCall('a1', 'running', { status: 'running', input: { id: 'running' }, time: { start: 1 } }),
        skillCall('a1', 'failed', { status: 'error', input: { id: 'failed' }, error: 'Skill not found', time: { start: 1, end: 2 } }),
      ],
    } satisfies Record<string, Part[]>;
    expect(selectLoadedSkills([assistant('a1')], parts)).toEqual([]);
    expect(selectLoadedSkills([], {})).toEqual([]);
  });
});

describe('resolveLoadedSkillTarget', () => {
  const installed = [
    { id: 'demo', name: 'demo', path: '/p/.opencode/skills/demo/SKILL.md' },
    { id: 'opencode', name: 'OpenCode', path: '<built-in>' },
  ];

  test('an installed skill file opens by its path', () => {
    expect(resolveLoadedSkillTarget({ id: 'demo', name: 'demo' }, installed)).toEqual({ kind: 'file', path: '/p/.opencode/skills/demo/SKILL.md' });
  });

  test('a built-in skill opens in Settings under its installed name', () => {
    // The tool reports the id; Settings selects by name, which differs here.
    expect(resolveLoadedSkillTarget({ id: 'opencode', name: 'opencode', directory: 'skill://opencode' }, installed))
      .toEqual({ kind: 'settings', name: 'OpenCode' });
    expect(resolveLoadedSkillTarget({ id: 'report', name: 'Report' }, [{ id: 'report', name: 'Report', path: 'skill://report/SKILL.md' }]))
      .toEqual({ kind: 'settings', name: 'Report' });
  });

  test('a skill the list has not read opens from the folder the tool reported, or in Settings without one', () => {
    expect(resolveLoadedSkillTarget({ id: 'fresh', name: 'fresh', directory: '/p/.opencode/skills/fresh/' }, []))
      .toEqual({ kind: 'file', path: '/p/.opencode/skills/fresh/SKILL.md' });
    expect(resolveLoadedSkillTarget({ id: 'gone', name: 'gone', directory: 'skill://gone' }, [])).toEqual({ kind: 'settings', name: 'gone' });
    expect(resolveLoadedSkillTarget({ id: 'attached', name: 'attached' }, [])).toEqual({ kind: 'settings', name: 'attached' });
  });
});
