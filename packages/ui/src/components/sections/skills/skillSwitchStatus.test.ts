import { describe, expect, test } from 'bun:test';
import type { SkillPolicyEntry, SkillPolicyState } from '@/stores/skillAvailability';
import { describeSkillAvailability, describeSwitchesUnavailable, switchedOffIn } from './skillSwitchStatus';

const summary = (overrides: Partial<SkillPolicyState> = {}): SkillPolicyState => ({
  version: '2.0.29',
  location: 'policies',
  writable: true,
  effectiveAvailable: true,
  scopes: {
    global: { path: '/config/opencode.json', error: null },
    project: { path: '/repo/.opencode/opencode.json', error: null },
  },
  skills: new Map(),
  ...overrides,
});
const view = (state: SkillPolicyState | null, error: string | null = null) => ({ state, error });

const entry = (overrides: Partial<SkillPolicyEntry>): SkillPolicyEntry => ({
  disabledIn: { global: false, project: false },
  effective: 'enabled',
  decidedBy: null,
  ...overrides,
});

describe('describeSkillAvailability', () => {
  test('names the switch that turned the skill off', () => {
    const global = entry({
      disabledIn: { global: true, project: false },
      effective: 'disabled',
      decidedBy: { path: '/config/opencode.json', resource: 'skill:a', effect: 'deny', scope: 'global', owned: true },
    });
    expect(describeSkillAvailability(view(summary()), global).key).toBe('settings.skills.switches.status.offGlobal');
    const project = entry({
      disabledIn: { global: false, project: true },
      effective: 'disabled',
      decidedBy: { path: '/repo/.opencode/opencode.json', resource: 'skill:a', effect: 'deny', scope: 'project', owned: true },
    });
    expect(describeSkillAvailability(view(summary()), project).key).toBe('settings.skills.switches.status.offProject');
  });

  test('a rule the switches did not write is named with its file', () => {
    const foreign = entry({
      effective: 'disabled',
      decidedBy: { path: '/repo/opencode.json', resource: 'skill:*', effect: 'deny', scope: 'other', owned: false },
    });
    expect(describeSkillAvailability(view(summary()), foreign)).toEqual({
      key: 'settings.skills.switches.status.blockedByRule',
      values: { path: '/repo/opencode.json' },
    });
    // A user's own exact deny in the global file is not the switch's.
    const userRule = entry({
      effective: 'disabled',
      decidedBy: { path: null, resource: 'skill:a', effect: 'deny', scope: 'global', owned: false },
    });
    expect(describeSkillAvailability(view(summary()), userRule).key).toBe('settings.skills.switches.status.blockedByUnknownRule');
  });

  test('an allow rule that overrides a switch is named', () => {
    const allowed = entry({
      disabledIn: { global: false, project: true },
      decidedBy: { path: '/config/opencode.json', resource: 'skill:a', effect: 'allow', scope: 'global', owned: false },
    });
    expect(describeSkillAvailability(view(summary()), allowed)).toEqual({
      key: 'settings.skills.switches.status.enabledByRule',
      values: { path: '/config/opencode.json' },
    });
  });

  test('unknown, unread and missing entries never read as off', () => {
    expect(describeSkillAvailability(null, undefined).key).toBe('settings.skills.switches.status.notRead');
    expect(describeSkillAvailability(view(summary()), undefined).key).toBe('settings.skills.switches.status.unknown');
    expect(describeSkillAvailability(view(summary()), entry({ effective: 'unknown' })).key).toBe('settings.skills.switches.status.unknown');
  });
});

describe('switch positions and availability', () => {
  test('a switch shows only its own rule, and no position when its file was not read', () => {
    const off = entry({ disabledIn: { global: true, project: null }, effective: 'disabled' });
    expect(switchedOffIn(view(summary()), off, 'global')).toBe(true);
    // No project file yet: nothing switched off there.
    expect(switchedOffIn(view(summary()), off, 'project')).toBe(false);
    const unreadable = summary({ scopes: { global: { path: '/config/opencode.json', error: 'EACCES' }, project: null } });
    expect(switchedOffIn(view(unreadable), off, 'global')).toBeNull();
    expect(switchedOffIn(view(unreadable), off, 'project')).toBeNull();
  });

  test('switches are read-only without a policy read or an enforcing OpenCode', () => {
    expect(describeSwitchesUnavailable(null)?.key).toBe('settings.skills.switches.status.notRead');
    expect(describeSwitchesUnavailable(view(summary({ writable: false, version: '2.0.24', location: null })))?.key)
      .toBe('settings.skills.switches.status.unsupported');
    expect(describeSwitchesUnavailable(view(summary({ writable: false, version: null, location: null })))?.key)
      .toBe('settings.skills.switches.status.unreachable');
    expect(describeSwitchesUnavailable(view(summary()))).toBeNull();
  });
});
