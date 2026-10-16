import { describe, expect, test } from 'bun:test';
import { reportRenameResult } from './renameFeedback';

const run = (result: Parameters<typeof reportRenameResult>[0]) => {
  const shown: Array<[string, string]> = [];
  const selected: string[] = [];
  reportRenameResult(result, 'new-skill', {
    t: (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key),
    toast: {
      success: (message) => shown.push(['success', message]),
      warning: (message) => shown.push(['warning', message]),
      error: (message) => shown.push(['error', message]),
    },
    select: (id) => selected.push(id),
  });
  return { shown, selected };
};

describe('reportRenameResult', () => {
  test('a clean rename says so and selects the new id', () => {
    expect(run({ ok: true, id: 'new-skill', oldRuleCleanupFailed: [] })).toEqual({
      shown: [['success', 'settings.skills.sidebar.toast.skillRenamed {"name":"new-skill"}']],
      selected: ['new-skill'],
    });
  });

  test('a rename that left the old switch rule behind is still a success, with a warning naming the files', () => {
    const { shown, selected } = run({
      ok: true,
      id: 'new-skill',
      oldRuleCleanupFailed: [
        { scope: 'global', path: '/config/opencode.json' },
        { scope: 'project', path: '/repo/.opencode/opencode.json' },
      ],
    });
    expect(shown).toEqual([
      ['success', 'settings.skills.sidebar.toast.skillRenamed {"name":"new-skill"}'],
      ['warning', 'settings.skills.sidebar.toast.renameOldSwitchRuleKept {"paths":"/config/opencode.json, /repo/.opencode/opencode.json"}'],
    ]);
    expect(selected).toEqual(['new-skill']);
  });

  test('a refused rename is an error and selects nothing', () => {
    expect(run({ ok: false })).toEqual({ shown: [['error', 'settings.skills.sidebar.toast.renameFailed']], selected: [] });
  });
});
