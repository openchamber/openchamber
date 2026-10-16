import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  carryOwnedSkillDeny,
  createSkillPolicyService,
  findDecidingSkillStatement,
  handleSkillPolicyWrite,
  isValidSkillPolicyId,
  listOwnedSkillDenies,
  setSkillDisabled,
  skillIdFromPath,
  skillPolicyLocation,
} from './skill-policy.js';
import { readConfigFile, writeConfig } from './shared.js';

const deny = (resource) => ({ action: 'integration.use', resource, effect: 'deny' });
const allow = (resource) => ({ action: 'integration.use', resource, effect: 'allow' });
const doc = (filePath, info) => ({ type: 'document', path: filePath, info });
// The statement a switch writes: an exact deny with the provenance key.
const owned = (id) => ({ ...deny(`skill:${id}`), openchamber: 'skill-switch' });
// A `readState` answer's entries by id.
const byId = (state) => new Map(state.skills.map(({ id, ...entry }) => [id, entry]));

describe('skillPolicyLocation', () => {
  it('writes experimental.policies on 2.0.25 to 2.0.28 and policies from 2.0.29', () => {
    expect(skillPolicyLocation('2.0.25')).toBe('experimental.policies');
    expect(skillPolicyLocation('2.0.28')).toBe('experimental.policies');
    expect(skillPolicyLocation('2.0.29')).toBe('policies');
    expect(skillPolicyLocation('2.0.30-beta.1')).toBe('policies');
    expect(skillPolicyLocation('2.1.0')).toBe('policies');
  });

  it('answers null where OpenCode does not enforce skill policies', () => {
    for (const version of ['2.0.24', '2.0.20', '1.18.32', '3.0.0', 'nonsense', null, undefined]) {
      expect(skillPolicyLocation(version)).toBeNull();
    }
  });
});

describe('skill ids', () => {
  it('accepts folder-style ids and refuses wildcards, separators and padding', () => {
    for (const id of ['deploy', 'Deploy_2', 'my.skill', 'Same Name']) expect(isValidSkillPolicyId(id)).toBe(true);
    for (const id of ['', ' deploy', 'deploy ', 'skill*', 'sk?ll', 'a/b', 'a\\b', '..', 'a\nb', 42, null]) {
      expect(isValidSkillPolicyId(id)).toBe(false);
    }
  });

  it('derives the id from the folder of SKILL.md or a loose markdown file, never the display name', () => {
    expect(skillIdFromPath('/repo/.opencode/skills/beta-one/SKILL.md')).toBe('beta-one');
    expect(skillIdFromPath('C:\\Users\\u\\.agents\\skills\\wild-a\\SKILL.md')).toBe('wild-a');
    expect(skillIdFromPath('/builtin/opencode.md')).toBe('opencode');
    expect(skillIdFromPath('/repo/notes.txt')).toBeNull();
    expect(skillIdFromPath(null)).toBeNull();
  });
});

describe('setSkillDisabled', () => {
  it('round-trips through top-level policies on 2.0.29, leaving the list it added empty', () => {
    const original = { $schema: 'https://opencode.ai/config.json', model: 'a/b' };
    const config = structuredClone(original);

    expect(setSkillDisabled(config, 'alpha-skill', true, 'policies')).toBe(true);
    expect(config.policies).toEqual([owned('alpha-skill')]);
    expect(config.experimental).toBeUndefined();

    expect(setSkillDisabled(config, 'alpha-skill', true, 'policies')).toBe(false);
    expect(setSkillDisabled(config, 'alpha-skill', false, 'policies')).toBe(true);
    expect(config).toEqual({ ...original, policies: [] });
    expect(setSkillDisabled(config, 'alpha-skill', false, 'policies')).toBe(false);
  });

  it('writes experimental.policies on 2.0.25 to 2.0.28 and keeps the experimental siblings', () => {
    const config = { experimental: { batch_tool: true }, policies: [deny('skill:ignored-here')] };

    expect(setSkillDisabled(config, 'alpha-skill', true, 'experimental.policies')).toBe(true);
    expect(config.experimental).toEqual({ batch_tool: true, policies: [owned('alpha-skill')] });
    // Top-level policies are not read by these versions, so they are left alone.
    expect(config.policies).toEqual([deny('skill:ignored-here')]);

    expect(setSkillDisabled(config, 'alpha-skill', false, 'experimental.policies')).toBe(true);
    expect(config).toEqual({ experimental: { batch_tool: true, policies: [] }, policies: [deny('skill:ignored-here')] });
  });

  it('keeps a policies list and an experimental object a user wrote empty', () => {
    for (const [original, location, after] of [
      [{ policies: [] }, 'policies', { policies: [] }],
      [{ experimental: { policies: [] } }, 'experimental.policies', { experimental: { policies: [] } }],
      // 2.0.29 writes the top-level list; the experimental one stays as it was.
      [{ experimental: { policies: [] } }, 'policies', { experimental: { policies: [] }, policies: [] }],
    ]) {
      const config = structuredClone(original);
      expect(setSkillDisabled(config, 'alpha-skill', true, location)).toBe(true);
      expect(setSkillDisabled(config, 'alpha-skill', false, location)).toBe(true);
      expect(config).toEqual(after);
    }
  });

  it('keeps user-authored wildcards, allows, other actions and display-name rules in place and in order', () => {
    const userRules = [
      deny('skill:wild-*'),
      allow('skill:alpha-skill'),
      { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
      deny('skill:Alpha Display'),
      deny('mcp:github'),
    ];
    const config = { policies: structuredClone(userRules) };

    setSkillDisabled(config, 'alpha-skill', true, 'policies');
    expect(config.policies).toEqual([...userRules, owned('alpha-skill')]);
    setSkillDisabled(config, 'alpha-skill', false, 'policies');
    expect(config.policies).toEqual(userRules);

    // Enabling a skill a wildcard denies removes nothing: the switch does not
    // own the wildcard and never answers it with an allow.
    expect(setSkillDisabled(config, 'wild-a', false, 'policies')).toBe(false);
    expect(config.policies).toEqual(userRules);
  });

  it('keeps a user exact deny: off adds nothing, on removes nothing', () => {
    const config = { policies: [deny('skill:alpha-skill')], experimental: { policies: [deny('skill:beta')] } };
    const before = structuredClone(config);

    expect(setSkillDisabled(config, 'alpha-skill', true, 'policies')).toBe(false);
    expect(setSkillDisabled(config, 'alpha-skill', false, 'policies')).toBe(false);
    expect(setSkillDisabled(config, 'beta', false, 'policies')).toBe(false);
    expect(config).toEqual(before);
    expect(listOwnedSkillDenies(config, 'policies')).toEqual([]);
  });

  it('removes only the marked deny when a user exact deny sits beside it', () => {
    const config = { policies: [owned('alpha-skill'), deny('skill:alpha-skill')] };
    expect(setSkillDisabled(config, 'alpha-skill', false, 'policies')).toBe(true);
    expect(config.policies).toEqual([deny('skill:alpha-skill')]);
  });

  it('adds a deny after a later allow overrides an earlier one, and removes only its own on enable', () => {
    const config = { policies: [deny('skill:alpha-skill'), allow('skill:alpha-skill')] };
    expect(setSkillDisabled(config, 'alpha-skill', true, 'policies')).toBe(true);
    expect(config.policies).toEqual([deny('skill:alpha-skill'), allow('skill:alpha-skill'), owned('alpha-skill')]);
    expect(setSkillDisabled(config, 'alpha-skill', false, 'policies')).toBe(true);
    expect(config.policies).toEqual([deny('skill:alpha-skill'), allow('skill:alpha-skill')]);
  });

  it('on 2.0.29 also clears a marked deny under the deprecated experimental key', () => {
    const config = { experimental: { policies: [owned('alpha-skill')] } };
    expect(setSkillDisabled(config, 'alpha-skill', true, 'policies')).toBe(false);
    expect(setSkillDisabled(config, 'alpha-skill', false, 'policies')).toBe(true);
    expect(config).toEqual({ experimental: { policies: [] } });
  });

  it('refuses a config it would have to rewrite to hold the rule', () => {
    expect(() => setSkillDisabled({ policies: 'deny all' }, 'alpha-skill', true, 'policies')).toThrow(/not a list/);
    expect(() => setSkillDisabled({ experimental: true }, 'alpha-skill', true, 'experimental.policies')).toThrow(/not an object/);
    expect(() => setSkillDisabled({}, 'skill-*', true, 'policies')).toThrow(/Invalid skill id/);
    expect(() => setSkillDisabled({}, 'alpha-skill', true, null)).toThrow(/Unknown policy location/);
  });

  it('lists only the marked denies a file holds', () => {
    const config = {
      policies: [owned('alpha-skill'), deny('skill:user-exact'), deny('skill:*'), allow('skill:beta'), deny('mcp:x')],
      experimental: { policies: [owned('old')] },
    };
    expect(listOwnedSkillDenies(config, 'policies').sort()).toEqual(['alpha-skill', 'old']);
    expect(listOwnedSkillDenies(config, 'experimental.policies')).toEqual(['old']);
  });
});

describe('findDecidingSkillStatement', () => {
  const globalPath = '/home/u/.config/opencode/opencode.json';
  const projectPath = '/repo/.opencode/opencode.json';

  it('lets a global rule win over a project rule in both directions', () => {
    expect(findDecidingSkillStatement([
      doc(globalPath, { policies: [deny('skill:alpha')] }),
      doc(projectPath, { policies: [allow('skill:alpha')] }),
    ], 'alpha', 'policies')).toEqual({ path: globalPath, resource: 'skill:alpha', effect: 'deny' });

    expect(findDecidingSkillStatement([
      doc(globalPath, { policies: [allow('skill:*')] }),
      doc(projectPath, { policies: [deny('skill:alpha')] }),
    ], 'alpha', 'policies')).toEqual({ path: globalPath, resource: 'skill:*', effect: 'allow' });
  });

  it('on 2.0.29 takes the last matching statement of a document, experimental ones first', () => {
    expect(findDecidingSkillStatement([
      doc(projectPath, { experimental: { policies: [allow('skill:alpha')] }, policies: [deny('skill:*')] }),
    ], 'alpha', 'policies')).toEqual({ path: projectPath, resource: 'skill:*', effect: 'deny' });
    expect(findDecidingSkillStatement([
      doc(projectPath, { policies: [deny('skill:*'), allow('skill:wild-a')] }),
    ], 'wild-a', 'policies')?.effect).toBe('allow');
  });

  it('on 2.0.25 to 2.0.28 ignores top-level policies and honours the experimental order', () => {
    const entries = [
      doc(globalPath, { policies: [deny('skill:alpha')] }),
      doc(projectPath, { experimental: { policies: [deny('skill:*'), allow('skill:alpha')] }, policies: [deny('skill:alpha')] }),
    ];
    expect(findDecidingSkillStatement(entries, 'alpha', 'experimental.policies'))
      .toEqual({ path: projectPath, resource: 'skill:alpha', effect: 'allow' });
    expect(findDecidingSkillStatement([doc(globalPath, { policies: [deny('skill:alpha')] })], 'alpha', 'experimental.policies')).toBeNull();
    // The same documents on 2.0.29: the global top-level deny wins.
    expect(findDecidingSkillStatement(entries, 'alpha', 'policies')).toEqual({ path: globalPath, resource: 'skill:alpha', effect: 'deny' });
  });

  it('matches ids only, never display names, and skips directory entries and other actions', () => {
    const entries = [
      { type: 'directory', path: '/repo/.opencode' },
      doc(projectPath, { policies: [deny('skill:Alpha Display'), { action: 'tool.use', resource: 'skill:alpha', effect: 'deny' }] }),
    ];
    expect(findDecidingSkillStatement(entries, 'alpha', 'policies')).toBeNull();
  });
});

const tempDirs = [];
const makeTemp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-policy-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A config document the way OpenCode serves it, as measured on 2.0.25,
 * 2.0.28, 2.0.29 and 2.0.30: statements lose the provenance key, and before 2.0.29 the top-level
 * `policies` key is not part of the schema.
 */
const servedInfo = (config, version) => {
  const strip = (rules) => rules.map(({ action, resource, effect }) => ({ action, resource, effect }));
  const info = structuredClone(config);
  if (Array.isArray(info.experimental?.policies)) info.experimental.policies = strip(info.experimental.policies);
  if (skillPolicyLocation(version) === 'experimental.policies') delete info.policies;
  else if (Array.isArray(info.policies)) info.policies = strip(info.policies);
  return info;
};

/**
 * A stand-in for the running OpenCode: it serves the documents it last
 * "reloaded" from the given files. `reload()` picks up the files as they are.
 */
const fakeOpenCode = ({ version = '2.0.29', files, live = true }) => {
  let snapshot = [];
  const reload = () => {
    snapshot = files.flatMap((file) => {
      try {
        return fs.existsSync(file) ? [doc(file, servedInfo(readConfigFile(file), version))] : [];
      } catch {
        return [];
      }
    });
  };
  reload();
  return {
    reload,
    reader: {
      readVersion: async () => {
        if (version instanceof Error) throw version;
        return version;
      },
      readConfigEntries: async () => {
        if (live) reload();
        return snapshot;
      },
    },
  };
};

const setup = ({ globalText = null, projectText = null, version = '2.0.29', live = true } = {}) => {
  const root = makeTemp();
  const globalPath = path.join(root, 'config', 'opencode.json');
  const projectDir = path.join(root, 'repo');
  const projectPath = path.join(projectDir, '.opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  if (globalText !== null) fs.writeFileSync(globalPath, globalText);
  if (projectText !== null) fs.writeFileSync(projectPath, projectText);
  // OpenCode lists global documents before project ones.
  const openCode = fakeOpenCode({ version, files: [globalPath, projectPath], live });
  const service = createSkillPolicyService({
    resolveTargets: (directory) => ({ global: globalPath, project: directory ? projectPath : null }),
    readConfigFile,
    writeConfig,
    sleep: async () => {},
    confirmAttempts: 3,
  });
  return { root, globalPath, projectDir, projectPath, openCode, service };
};

describe('createSkillPolicyService', () => {
  it('saves a project switch, confirms it, and restores the JSONC file on re-enable', async () => {
    const projectText = [
      '{',
      '  // keep this comment',
      '  "model": "a/b",',
      '  "policies": [',
      '    { "action": "integration.use", "resource": "skill:wild-*", "effect": "deny" }, // user rule',
      '  ],',
      '}',
      '',
    ].join('\n');
    const globalText = '{\n  "theme": "dark"\n}\n';
    const { projectDir, projectPath, globalPath, openCode, service } = setup({ globalText, projectText });

    const off = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: false, openCode: openCode.reader });
    expect(off.saved).toEqual({ scope: 'project', path: projectPath, disabled: true, changed: true });
    expect(off.confirmed).toBe(true);
    expect(off.state.location).toBe('policies');
    expect(off.policy).toMatchObject({
      disabledIn: { global: false, project: true },
      effective: 'disabled',
      decidedBy: { path: projectPath, scope: 'project', owned: true, resource: 'skill:alpha-skill' },
    });
    const savedText = fs.readFileSync(projectPath, 'utf8');
    expect(savedText).toContain('// keep this comment');
    expect(savedText).toContain('// user rule');
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(globalText);

    const on = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: true, openCode: openCode.reader });
    expect(on.saved.changed).toBe(true);
    expect(on.confirmed).toBe(true);
    expect(on.policy).toMatchObject({ disabledIn: { project: false }, effective: 'enabled', decidedBy: null });
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectText);
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(globalText);
  });

  it('keeps empty policy lists a user wrote, and the JSONC around them, through off and on', async () => {
    const projectText = [
      '{',
      '  // keep this comment',
      '  "experimental": { "policies": [] },',
      '  "policies": [], // user list',
      '  "model": "a/b"',
      '}',
      '',
    ].join('\n');
    for (const version of ['2.0.28', '2.0.29']) {
      const { projectDir, projectPath, openCode, service } = setup({ projectText, version });
      const off = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: false, openCode: openCode.reader });
      expect(off.saved).toMatchObject({ disabled: true, changed: true });
      const on = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: true, openCode: openCode.reader });
      expect(on.saved).toMatchObject({ disabled: false, changed: true });
      expect(readConfigFile(projectPath)).toEqual({ experimental: { policies: [] }, policies: [], model: 'a/b' });
      const text = fs.readFileSync(projectPath, 'utf8');
      expect(text).toContain('// keep this comment');
      expect(text).toContain('// user list');
    }
  });

  it('lists every valid id through JSON, __proto__ and Object.prototype names included', async () => {
    const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const { projectDir, openCode, service } = setup({ projectText: JSON.stringify({ policies: [owned('constructor')] }) });
    const off = await service.setEnabled({ directory: projectDir, id: '__proto__', scope: 'project', enabled: false, openCode: openCode.reader });
    expect(off.policy).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });

    const state = JSON.parse(JSON.stringify(await service.readState({ directory: projectDir, ids, openCode: openCode.reader })));
    expect(state.skills.map((entry) => entry.id).sort()).toEqual([...ids].sort());
    expect(byId(state).get('__proto__')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled', decidedBy: { resource: 'skill:__proto__', owned: true } });
    expect(byId(state).get('constructor')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
    expect(byId(state).get('toString')).toEqual({ disabledIn: { global: false, project: false }, effective: 'enabled', decidedBy: null });
  });

  it('writes experimental.policies against OpenCode 2.0.28', async () => {
    const { projectDir, globalPath, openCode, service } = setup({ version: '2.0.28' });
    const result = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'global', enabled: false, openCode: openCode.reader });
    expect(result.confirmed).toBe(true);
    expect(readConfigFile(globalPath)).toEqual({ experimental: { policies: [owned('alpha-skill')] } });
  });

  it('reports a project switch a global rule overrides, without touching the global file', async () => {
    const globalText = JSON.stringify({ policies: [owned('alpha-skill')] }, null, 2);
    const { projectDir, globalPath, openCode, service } = setup({ globalText });

    const result = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: true, openCode: openCode.reader });
    expect(result.saved.changed).toBe(false);
    expect(result.policy).toMatchObject({
      disabledIn: { global: true, project: false },
      effective: 'disabled',
      decidedBy: { scope: 'global', owned: true, path: globalPath },
    });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(globalText);

    const allowAll = setup({ globalText: JSON.stringify({ policies: [allow('skill:*')] }) });
    const kept = await allowAll.service.setEnabled({ directory: allowAll.projectDir, id: 'alpha-skill', scope: 'project', enabled: false, openCode: allowAll.openCode.reader });
    expect(kept.saved.changed).toBe(true);
    expect(kept.policy).toMatchObject({ disabledIn: { project: true }, effective: 'enabled', decidedBy: { scope: 'global', owned: false, effect: 'allow' } });
  });

  it('keeps a user exact deny through off and on, and reports it as not owned', async () => {
    const projectText = JSON.stringify({ policies: [deny('skill:alpha-skill')] }, null, 2);
    const { projectDir, projectPath, openCode, service } = setup({ projectText });

    const off = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: false, openCode: openCode.reader });
    expect(off.saved).toMatchObject({ disabled: false, changed: false });
    expect(off.confirmed).toBe(true);
    expect(off.policy).toMatchObject({
      disabledIn: { project: false },
      effective: 'disabled',
      decidedBy: { scope: 'project', owned: false, resource: 'skill:alpha-skill' },
    });

    const on = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: true, openCode: openCode.reader });
    expect(on.saved).toMatchObject({ disabled: false, changed: false });
    expect(on.policy).toMatchObject({ effective: 'disabled', decidedBy: { owned: false } });
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectText);
  });

  it('confirms a marked deny although OpenCode serves it without the provenance key', async () => {
    const { projectDir, globalPath, openCode, service } = setup({ version: '2.0.28' });
    const off = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'global', enabled: false, openCode: openCode.reader });
    expect(off.confirmed).toBe(true);
    expect(off.policy).toMatchObject({ disabledIn: { global: true }, decidedBy: { scope: 'global', owned: true } });
    expect(readConfigFile(globalPath)).toEqual({ experimental: { policies: [owned('alpha-skill')] } });
  });

  it('names a user wildcard that keeps a skill off after its switch is turned on', async () => {
    const { projectDir, projectPath, openCode, service } = setup({ projectText: JSON.stringify({ policies: [deny('skill:*')] }) });
    await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: false, openCode: openCode.reader });
    const on = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: true, openCode: openCode.reader });
    expect(readConfigFile(projectPath)).toEqual({ policies: [deny('skill:*')] });
    expect(on.policy).toMatchObject({ effective: 'disabled', decidedBy: { resource: 'skill:*', scope: 'project', owned: false } });
  });

  it('keeps every switch when many are flipped at once', async () => {
    const { projectDir, globalPath, openCode, service } = setup();
    const ids = Array.from({ length: 12 }, (_, index) => `skill-${index}`);
    await Promise.all(ids.map((id) => service.setEnabled({ directory: projectDir, id, scope: 'global', enabled: false, openCode: openCode.reader })));
    expect(listOwnedSkillDenies(readConfigFile(globalPath), 'policies').sort()).toEqual([...ids].sort());

    await Promise.all(ids.slice(0, 6).map((id) => service.setEnabled({ directory: projectDir, id, scope: 'global', enabled: true, openCode: openCode.reader })));
    expect(listOwnedSkillDenies(readConfigFile(globalPath), 'policies').sort()).toEqual(ids.slice(6).sort());
  });

  it('reports a saved switch OpenCode has not picked up as unconfirmed', async () => {
    const { projectDir, globalPath, openCode, service } = setup({ live: false });
    const result = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'global', enabled: false, openCode: openCode.reader });
    expect(result.saved).toMatchObject({ disabled: true, changed: true });
    expect(result.confirmed).toBe(false);
    expect(result.policy).toMatchObject({ disabledIn: { global: true }, effective: 'enabled' });
    expect(listOwnedSkillDenies(readConfigFile(globalPath))).toEqual(['alpha-skill']);
  });

  it('reports effective state as unknown when OpenCode config cannot be read after the write', async () => {
    const { projectDir, openCode, service } = setup();
    const reader = { ...openCode.reader, readConfigEntries: async () => { throw new Error('timeout'); } };
    const result = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'global', enabled: false, openCode: reader });
    expect(result.confirmed).toBe(false);
    expect(result.state.effectiveAvailable).toBe(false);
    expect(result.policy).toEqual({ disabledIn: { global: true, project: false }, effective: 'unknown', decidedBy: null });
  });

  it('refuses to write without a version that enforces skill policies, leaving files alone', async () => {
    const unreachable = setup({ version: new Error('ECONNREFUSED') });
    await expect(unreachable.service.setEnabled({ directory: null, id: 'alpha-skill', scope: 'global', enabled: false, openCode: unreachable.openCode.reader }))
      .rejects.toMatchObject({ status: 503, code: 'opencode_unavailable' });
    expect(fs.existsSync(unreachable.globalPath)).toBe(false);

    const old = setup({ version: '2.0.24' });
    await expect(old.service.setEnabled({ directory: null, id: 'alpha-skill', scope: 'global', enabled: false, openCode: old.openCode.reader }))
      .rejects.toMatchObject({ status: 409, code: 'unsupported_version' });
    expect(fs.existsSync(old.globalPath)).toBe(false);
  });

  it('refuses invalid JSONC and a missing project scope without writing', async () => {
    const broken = '{ "policies": [ oops ] }';
    const { projectDir, globalPath, openCode, service } = setup({ globalText: broken });
    await expect(service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'global', enabled: false, openCode: openCode.reader }))
      .rejects.toMatchObject({ status: 409, code: 'invalid_config' });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(broken);

    await expect(service.setEnabled({ directory: null, id: 'alpha-skill', scope: 'project', enabled: false, openCode: openCode.reader }))
      .rejects.toMatchObject({ status: 409, code: 'scope_unavailable' });
  });

  it('leaves the file unchanged when the write itself fails', async () => {
    const { projectDir, globalPath, openCode } = setup({ globalText: '{}' });
    const service = createSkillPolicyService({
      resolveTargets: () => ({ global: globalPath, project: null }),
      readConfigFile,
      writeConfig: () => { throw new Error('Failed to write OpenCode configuration'); },
      sleep: async () => {},
    });
    await expect(service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'global', enabled: false, openCode: openCode.reader }))
      .rejects.toThrow('Failed to write OpenCode configuration');
    expect(fs.readFileSync(globalPath, 'utf8')).toBe('{}');
  });

  it('reads saved and effective state, including switched-off ids no longer installed', async () => {
    const { projectDir, globalPath, projectPath, openCode, service } = setup({
      globalText: JSON.stringify({ policies: [owned('gone-skill'), deny('skill:user-gone')] }),
      projectText: JSON.stringify({ policies: [owned('alpha-skill')] }),
    });
    const state = await service.readState({ directory: projectDir, ids: ['alpha-skill', 'beta-skill', 'bad*id'], openCode: openCode.reader });
    expect(state).toMatchObject({
      version: '2.0.29',
      location: 'policies',
      writable: true,
      effectiveAvailable: true,
      scopes: { global: { path: globalPath, error: null }, project: { path: projectPath, error: null } },
    });
    expect(state.skills.map((entry) => entry.id).sort()).toEqual(['alpha-skill', 'beta-skill', 'gone-skill']);
    expect(byId(state).get('beta-skill')).toEqual({ disabledIn: { global: false, project: false }, effective: 'enabled', decidedBy: null });
    expect(byId(state).get('gone-skill')).toMatchObject({ disabledIn: { global: true, project: false }, effective: 'disabled' });
  });

  it('never infers a disabled skill from an OpenCode it cannot read', async () => {
    const { projectDir, service } = setup({ projectText: JSON.stringify({ policies: [owned('alpha-skill')] }) });
    const reader = { readVersion: async () => { throw new Error('down'); }, readConfigEntries: async () => { throw new Error('down'); } };
    const state = await service.readState({ directory: projectDir, ids: ['alpha-skill', 'beta-skill'], openCode: reader });
    expect(state).toMatchObject({ version: null, location: null, writable: false, effectiveAvailable: false });
    expect(byId(state).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: true }, effective: 'unknown', decidedBy: null });
    expect(byId(state).get('beta-skill').effective).toBe('unknown');
  });

  it('reports an unreadable scope file without failing the other scope', async () => {
    const { projectDir, openCode, service } = setup({ globalText: '{ nope', projectText: JSON.stringify({ policies: [owned('alpha-skill')] }) });
    const state = await service.readState({ directory: projectDir, ids: ['alpha-skill'], openCode: openCode.reader });
    expect(state.scopes.global.error).toMatch(/invalid JSONC/);
    expect(byId(state).get('alpha-skill').disabledIn).toEqual({ global: null, project: true });
  });

  // OpenCode answers `GET /api/config` without a document it cannot parse, so
  // a switch's deny in that file is missing from what it serves.
  it('reports unknown, not enabled, while a scope file it cannot parse may hold the deciding rule', async () => {
    const validProject = JSON.stringify({ policies: [owned('alpha-skill')] });
    const { projectDir, projectPath, openCode, service } = setup({ globalText: '{}', projectText: validProject });
    const read = () => service.readState({ directory: projectDir, ids: ['alpha-skill', 'beta-skill'], openCode: openCode.reader });
    expect(byId(await read()).get('alpha-skill').effective).toBe('disabled');

    fs.writeFileSync(projectPath, `${validProject.slice(0, -1)} oops }`);
    const broken = await read();
    expect(broken.effectiveAvailable).toBe(true);
    expect(broken.scopes.project.error).toMatch(/invalid JSONC/);
    expect(byId(broken).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: null }, effective: 'unknown', decidedBy: null });
    expect(byId(broken).get('beta-skill')).toEqual({ disabledIn: { global: false, project: null }, effective: 'unknown', decidedBy: null });

    fs.writeFileSync(projectPath, validProject);
    expect(byId(await read()).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
    const on = await service.setEnabled({ directory: projectDir, id: 'alpha-skill', scope: 'project', enabled: true, openCode: openCode.reader });
    expect(on.policy).toEqual({ disabledIn: { global: false, project: false }, effective: 'enabled', decidedBy: null });
  });

  it('keeps a deny from a readable file deciding, and does not trust an allow, while another scope file is unparsable', async () => {
    const broken = '{ "policies": [ oops ] }';
    const denied = setup({ globalText: JSON.stringify({ policies: [owned('alpha-skill')] }), projectText: broken });
    const deniedState = await denied.service.readState({ directory: denied.projectDir, ids: ['alpha-skill'], openCode: denied.openCode.reader });
    expect(byId(deniedState).get('alpha-skill')).toMatchObject({
      disabledIn: { global: true, project: null },
      effective: 'disabled',
      decidedBy: { scope: 'global', owned: true },
    });

    const allowed = setup({ globalText: JSON.stringify({ policies: [allow('skill:*')] }), projectText: broken });
    const allowedState = await allowed.service.readState({ directory: allowed.projectDir, ids: ['alpha-skill'], openCode: allowed.openCode.reader });
    expect(byId(allowedState).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: null }, effective: 'unknown', decidedBy: null });

    // Without a directory the project file is not a scope, so it is not consulted.
    const globalOnly = await allowed.service.readState({ directory: null, ids: ['alpha-skill'], openCode: allowed.openCode.reader });
    expect(byId(globalOnly).get('alpha-skill')).toMatchObject({ effective: 'enabled', decidedBy: { effect: 'allow' } });
  });
});

describe('handleSkillPolicyWrite', () => {
  it('validates the request and maps failures to statuses', async () => {
    const { projectDir, globalPath, openCode, service } = setup();
    const call = (body, directory = projectDir, installed = ['alpha-skill']) => handleSkillPolicyWrite({
      service,
      body,
      directory,
      openCode: openCode.reader,
      listInstalledSkillIds: async () => new Set(installed),
    });

    expect((await call({ id: 'alpha-skill', scope: 'project', enabled: false }, null)).status).toBe(400);
    expect((await call({ id: 'skill-*', scope: 'global', enabled: false })).body.error.code).toBe('invalid_id');
    expect((await call({ id: 'alpha-skill', scope: 'workspace', enabled: false })).body.error.code).toBe('invalid_scope');
    expect((await call({ id: 'alpha-skill', scope: 'global', enabled: 'no' })).body.error.code).toBe('invalid_enabled');
    expect(await call({ id: 'not-installed', scope: 'global', enabled: false })).toMatchObject({ status: 404, body: { ok: false, error: { code: 'unknown_skill' } } });
    expect(fs.existsSync(globalPath)).toBe(false);

    // Turning on never writes a rule, so an id that is not installed any more
    // can still be cleared.
    const cleared = await call({ id: 'not-installed', scope: 'global', enabled: true });
    expect(cleared).toMatchObject({ status: 200, body: { ok: true, id: 'not-installed', saved: { changed: false } } });

    const saved = await call({ id: 'alpha-skill', scope: 'global', enabled: false });
    expect(saved).toMatchObject({ status: 200, body: { ok: true, confirmed: true, saved: { disabled: true, changed: true } } });
  });
});

describe('carryOwnedSkillDeny', () => {
  it('adds the switch rule for the new id next to the old one, in the same array, and copies no user rule', () => {
    const config = {
      experimental: { policies: [owned('old-id')] },
      policies: [deny('skill:old-id'), deny('skill:old-*'), owned('old-id')],
    };
    expect(carryOwnedSkillDeny(config, 'old-id', 'new-id')).toEqual([['experimental', 'policies'], ['policies']]);
    expect(config.experimental.policies).toEqual([owned('old-id'), owned('new-id')]);
    expect(config.policies).toEqual([deny('skill:old-id'), deny('skill:old-*'), owned('old-id'), owned('new-id')]);
  });

  it('changes nothing when only user rules name the old id, or the new id already has the switch rule', () => {
    const userOnly = { policies: [deny('skill:old-id')] };
    expect(carryOwnedSkillDeny(userOnly, 'old-id', 'new-id')).toEqual([]);
    expect(userOnly).toEqual({ policies: [deny('skill:old-id')] });
    const already = { policies: [owned('old-id'), owned('new-id')] };
    expect(carryOwnedSkillDeny(already, 'old-id', 'new-id')).toEqual([]);
  });
});

describe('carryForRename', () => {
  const read = (file) => readConfigFile(file);

  it('carries the switch rule in both scope files and drops the old one when no copy is left', async () => {
    const globalText = '{\n  // mine\n  "model": "a/b",\n  "policies": [\n    { "action": "integration.use", "resource": "skill:keep-*", "effect": "deny" }\n  ]\n}\n';
    const { projectDir, globalPath, projectPath, service } = setup({ globalText, projectText: JSON.stringify({ experimental: { policies: [owned('old-id')] } }) });
    const withGlobal = read(globalPath);
    setSkillDisabled(withGlobal, 'old-id', true, 'policies');
    writeConfig(withGlobal, globalPath);

    const carry = await service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false });
    expect(carry.carried.map((entry) => entry.scope).sort()).toEqual(['global', 'project']);
    expect(read(globalPath).policies).toEqual([deny('skill:keep-*'), owned('old-id'), owned('new-id')]);
    expect(read(projectPath)).toEqual({ experimental: { policies: [owned('old-id'), owned('new-id')] } });

    const outcome = await carry.finish();
    expect(outcome.removed.map((entry) => entry.scope).sort()).toEqual(['global', 'project']);
    expect(read(globalPath).policies).toEqual([deny('skill:keep-*'), owned('new-id')]);
    expect(read(projectPath)).toEqual({ experimental: { policies: [owned('new-id')] } });
    expect(fs.readFileSync(globalPath, 'utf8')).toContain('// mine');
  });

  it('keeps the old rule while another copy of the old id stays installed', async () => {
    const { projectDir, projectPath, service } = setup({ projectText: JSON.stringify({ policies: [owned('old-id')] }) });
    const carry = await service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: true });
    const outcome = await carry.finish();
    expect(outcome.kept.map((entry) => entry.scope)).toEqual(['project']);
    expect(read(projectPath)).toEqual({ policies: [owned('old-id'), owned('new-id')] });
  });

  it('undo gives back the files byte for byte', async () => {
    const projectText = '{\n  "policies": [\n    {"action":"integration.use","resource":"skill:old-id","effect":"deny","openchamber":"skill-switch"}\n  ]\n}\n';
    const { projectDir, projectPath, globalPath, service } = setup({ globalText: '{}\n', projectText });
    const carry = await service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false });
    expect(carry.carried).toHaveLength(1);
    expect(await carry.undo()).toEqual([]);
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectText);
    expect(fs.readFileSync(globalPath, 'utf8')).toBe('{}\n');
  });

  it('leaves empty policy lists a user wrote in place through carry, undo and finish', async () => {
    const projectText = JSON.stringify({ experimental: { policies: [] }, policies: [owned('old-id')] }, null, 2);
    const globalText = '{ "policies": [] }\n';
    const { projectDir, globalPath, projectPath, service } = setup({ globalText, projectText });

    const undone = await service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false });
    expect(await undone.undo()).toEqual([]);
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectText);

    const carry = await service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false });
    expect((await carry.finish()).removed.map((entry) => entry.scope)).toEqual(['project']);
    expect(read(projectPath)).toEqual({ experimental: { policies: [] }, policies: [owned('new-id')] });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(globalText);
  });

  it('writes nothing and does not carry user-written rules', async () => {
    const globalText = JSON.stringify({ policies: [deny('skill:old-id')] });
    const { projectDir, globalPath, projectPath, service } = setup({ globalText });
    const carry = await service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false });
    expect(carry.owning).toEqual([]);
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(globalText);
    expect(fs.existsSync(projectPath)).toBe(false);
  });

  it('stops before writing when a scope file cannot be read', async () => {
    const projectText = JSON.stringify({ policies: [owned('old-id')] });
    const { projectDir, projectPath, service } = setup({ globalText: '{ nope', projectText });
    await expect(service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false }))
      .rejects.toMatchObject({ status: 409, code: 'invalid_config' });
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectText);
  });

  it('restores the files already written when a later write fails', async () => {
    const { projectDir, globalPath, projectPath } = setup({
      globalText: JSON.stringify({ policies: [owned('old-id')] }),
      projectText: JSON.stringify({ policies: [owned('old-id')] }),
    });
    const globalBefore = fs.readFileSync(globalPath, 'utf8');
    const projectBefore = fs.readFileSync(projectPath, 'utf8');
    const service = createSkillPolicyService({
      resolveTargets: () => ({ global: globalPath, project: projectPath }),
      readConfigFile,
      writeConfig: (config, file) => {
        if (file === projectPath && JSON.stringify(config).includes('new-id')) throw new Error('disk full');
        writeConfig(config, file);
      },
    });
    await expect(service.carryForRename({ directory: projectDir, oldId: 'old-id', newId: 'new-id', keepOldRules: false }))
      .rejects.toMatchObject({ status: 500, code: 'write_failed' });
    expect(read(globalPath)).toEqual(JSON.parse(globalBefore));
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectBefore);
  });
});
