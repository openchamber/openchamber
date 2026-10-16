import { describe, expect, it } from 'vitest';
// The composer's own template. bun runs TS directly, so the mirror is checked
// against the file the UI ships.
import {
  buildSkillMentionInstruction as buildUiInstruction,
  parseSkillMentionInstruction as parseUiInstruction,
} from '../../../../ui/src/lib/skillMentionInstruction.ts';
import {
  buildSkillMentionInstruction,
  parseSkillMentionInstruction,
  queuedSkillReferences,
  withoutSwitchedOffSkills,
} from './skill-instruction.js';

const instruction = (...names) => buildUiInstruction(names);

describe('skill instruction template mirror', () => {
  it('builds and reads exactly what the UI builds and reads', () => {
    for (const names of [[], ['a'], ['alpha', 'Same Name'], ['with, comma', '$dollar']]) {
      expect(buildSkillMentionInstruction(names)).toBe(buildUiInstruction(names));
    }
    const texts = [
      instruction('alpha'),
      instruction('alpha', 'Same Name'),
      `${instruction('alpha')} and more`,
      'use the skill',
      instruction('alpha').replace('$alpha', 'alpha'),
      instruction('alpha').replace('$alpha', '$'),
    ];
    for (const text of texts) expect(parseSkillMentionInstruction(text)).toEqual(parseUiInstruction(text));
    expect(parseSkillMentionInstruction(instruction('alpha', 'Same Name'))).toEqual(['alpha', 'Same Name']);
  });
});

describe('withoutSwitchedOffSkills', () => {
  const states = (entries) => new Map(Object.entries(entries));
  const comment = { kind: 'context', text: 'Comment on a.ts', metadata: { openchamberContext: { kind: 'code-comment' } } };
  const synthetic = { kind: 'synthetic', text: instruction('alpha') };

  it('leaves out a skill switched off by id and keeps every other part as it was', () => {
    const skills = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
    const context = [comment, { kind: 'instruction', text: instruction('Alpha', 'Beta'), skills }, synthetic];
    const revised = withoutSwitchedOffSkills(context, { states: states({ alpha: 'disabled', beta: 'enabled' }), inventory: null });
    expect(revised).toEqual([
      comment,
      { kind: 'instruction', text: instruction('Beta'), skills: [{ id: 'beta', name: 'Beta' }] },
      synthetic,
    ]);
    expect(revised[0]).toBe(comment);
  });

  it('drops an instruction whose skills are all switched off, and keeps one whose state is unknown', () => {
    const only = { kind: 'instruction', text: instruction('Alpha'), skills: [{ id: 'alpha', name: 'Alpha' }] };
    expect(withoutSwitchedOffSkills([only], { states: states({ alpha: 'disabled' }), inventory: null })).toEqual([]);
    expect(withoutSwitchedOffSkills([only], { states: states({}), inventory: null })).toEqual([only]);
    expect(withoutSwitchedOffSkills([only], { states: states({ alpha: 'enabled' }), inventory: null })[0]).toBe(only);
  });

  it('removes only the switched-off id when two skills share a display name', () => {
    const part = {
      kind: 'instruction',
      text: instruction('Same Name', 'Same Name'),
      skills: [{ id: 'beta-one', name: 'Same Name' }, { id: 'beta-two', name: 'Same Name' }],
    };
    expect(withoutSwitchedOffSkills([part], { states: states({ 'beta-one': 'disabled', 'beta-two': 'enabled' }), inventory: null })).toEqual([
      { kind: 'instruction', text: instruction('Same Name'), skills: [{ id: 'beta-two', name: 'Same Name' }] },
    ]);
  });

  it('checks an instruction queued without ids by the names in its builder text', () => {
    const inventory = [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta-one', name: 'Same Name' },
      { id: 'beta-two', name: 'Same Name' },
    ];
    const legacy = { kind: 'instruction', text: instruction('Alpha', 'Same Name', 'unknown-skill') };
    // A shared name stays while one skill with it is not switched off; a name
    // no installed skill has stays too.
    expect(withoutSwitchedOffSkills([legacy], {
      states: states({ alpha: 'disabled', 'beta-one': 'disabled', 'beta-two': 'enabled' }),
      inventory,
    })).toEqual([{ kind: 'instruction', text: instruction('Same Name', 'unknown-skill') }]);
    expect(withoutSwitchedOffSkills([legacy], {
      states: states({ alpha: 'disabled', 'beta-one': 'disabled', 'beta-two': 'disabled' }),
      inventory,
    })).toEqual([{ kind: 'instruction', text: instruction('unknown-skill') }]);
    // A name can also be the id, as the UI resolves it.
    expect(withoutSwitchedOffSkills([{ kind: 'instruction', text: instruction('alpha') }], { states: states({ alpha: 'disabled' }), inventory })).toEqual([]);
  });

  it('delivers a legacy instruction as captured when the inventory is incomplete or the text is not the builder\'s', () => {
    const legacy = { kind: 'instruction', text: instruction('Alpha') };
    expect(withoutSwitchedOffSkills([legacy], { states: states({ alpha: 'disabled' }), inventory: null })).toEqual([legacy]);
    const handWritten = { kind: 'instruction', text: `Please use $Alpha. ${instruction('Alpha')}` };
    expect(withoutSwitchedOffSkills([handWritten], {
      states: states({ alpha: 'disabled' }),
      inventory: [{ id: 'alpha', name: 'Alpha' }],
    })).toEqual([handWritten]);
  });

  it('asks the lookup for ids and legacy names only', () => {
    expect(queuedSkillReferences([
      comment,
      synthetic,
      { kind: 'instruction', text: instruction('Alpha'), skills: [{ id: 'alpha', name: 'Alpha' }] },
      { kind: 'instruction', text: instruction('Gamma', 'Same Name') },
      { kind: 'instruction', text: 'use the skill' },
    ])).toEqual({ ids: ['alpha'], names: ['Gamma', 'Same Name'] });
    expect(queuedSkillReferences([comment])).toEqual({ ids: [], names: [] });
  });
});
