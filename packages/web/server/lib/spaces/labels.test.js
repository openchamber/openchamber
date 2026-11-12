import { describe, expect, it } from 'vitest';

import {
  buildSpaceLabels,
  buildToolsLabels,
  createSpaceId,
  hashProjectDirectory,
  isSpaceId,
  labelArgs,
  labelFilterArgs,
  normalizeSpaceName,
  parseSpaceLabels,
  parseToolsLabels,
  spaceResourceName,
  toolsKeyFromVolumeName,
  toolsLabelFilterArgs,
  toolsResourceName,
} from './labels.js';

const ID = 'a1b2c3d4e5f6';
const FIELDS = {
  id: ID,
  role: 'space',
  owner: 'install-a',
  project: hashProjectDirectory('/home/me/project'),
  name: 'Fix login',
  created: '2026-09-19T10:00:00.000Z',
};

describe('space ids', () => {
  it('creates 12 lowercase hex characters, different each time', () => {
    const first = createSpaceId();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(createSpaceId()).not.toBe(first);
  });

  it.each(['', 'A1B2C3D4E5F6', 'a1b2c3d4e5f', 'a1b2c3d4e5f6a', '../../../etc', 'a1b2c3d4e5f6\n', undefined, null])('rejects %j', (value) => {
    expect(isSpaceId(value)).toBe(false);
  });
});

describe('hashProjectDirectory', () => {
  it('is the first 16 hex characters of the sha256 of the directory', () => {
    expect(hashProjectDirectory('/home/me/project')).toBe('225df3094012a213');
    expect(hashProjectDirectory('/home/me/other')).not.toBe(hashProjectDirectory('/home/me/project'));
  });

  it('rejects an empty directory', () => {
    expect(() => hashProjectDirectory('  ')).toThrow(expect.objectContaining({ code: 'invalid_project_directory' }));
  });
});

describe('spaceResourceName', () => {
  it('is deterministic per id, role and suffix', () => {
    expect(spaceResourceName(ID, 'space')).toBe(`openchamber-space-${ID}-space`);
    expect(spaceResourceName(ID, 'network')).toBe(`openchamber-space-${ID}-network`);
    expect(spaceResourceName(ID, 'volume', 'work')).toBe(`openchamber-space-${ID}-volume-work`);
  });

  it('rejects a bad id, role or suffix', () => {
    expect(() => spaceResourceName('nope', 'space')).toThrow(expect.objectContaining({ code: 'invalid_space_id' }));
    expect(() => spaceResourceName(ID, 'gateway')).toThrow(expect.objectContaining({ code: 'invalid_role' }));
    expect(() => spaceResourceName(ID, 'volume', '../x')).toThrow(expect.objectContaining({ code: 'invalid_resource_suffix' }));
  });
});

describe('normalizeSpaceName', () => {
  it('trims and keeps punctuation', () => {
    expect(normalizeSpaceName('  Fix a=b, "c"  ')).toBe('Fix a=b, "c"');
  });

  it.each(['', '   ', 'two\nlines', 'x'.repeat(101), undefined, 'a\u2028b', 'a\u2029b', 'a\u0085b', 'a\u007fb'])('rejects %j', (value) => {
    expect(() => normalizeSpaceName(value)).toThrow(expect.objectContaining({ code: 'invalid_space_name' }));
  });
});

describe('buildSpaceLabels', () => {
  it('builds every label under openchamber.space', () => {
    expect(buildSpaceLabels(FIELDS)).toEqual({
      'openchamber.space': 'true',
      'openchamber.space.id': ID,
      'openchamber.space.role': 'space',
      'openchamber.space.owner': 'install-a',
      'openchamber.space.project': FIELDS.project,
      'openchamber.space.name': 'Fix login',
      'openchamber.space.created': '2026-09-19T10:00:00.000Z',
    });
  });

  it.each([
    ['invalid_space_id', { id: 'nope' }],
    ['invalid_role', { role: 'gateway' }],
    ['invalid_owner', { owner: 'a b' }],
    ['invalid_owner', { owner: 'a,openchamber.space.id=x' }],
    ['invalid_project', { project: '/home/me/project' }],
    ['invalid_space_name', { name: '' }],
    ['invalid_created', { created: 'yesterday-ish' }],
  ])('rejects with %s', (code, change) => {
    expect(() => buildSpaceLabels({ ...FIELDS, ...change })).toThrow(expect.objectContaining({ code }));
  });

  it('turns into --label arguments and --filter arguments', () => {
    expect(labelArgs({ a: '1', b: 'x=y' })).toEqual(['--label', 'a=1', '--label', 'b=x=y']);
    expect(labelFilterArgs({ owner: 'install-a' })).toEqual([
      '--filter', 'label=openchamber.space=true',
      '--filter', 'label=openchamber.space.owner=install-a',
    ]);
    expect(labelFilterArgs({ owner: 'install-a', spaceId: ID })).toEqual([
      '--filter', 'label=openchamber.space=true',
      '--filter', 'label=openchamber.space.owner=install-a',
      '--filter', `label=openchamber.space.id=${ID}`,
    ]);
  });
});

describe('parseSpaceLabels', () => {
  it('round-trips a name with commas, equals signs and quotes', () => {
    const name = 'Fix a=b, openchamber.space.id=ffffffffffff, "c"';
    const labels = buildSpaceLabels({ ...FIELDS, name });

    expect(parseSpaceLabels(labels)).toEqual({ ...FIELDS, name });
  });

  it.each([
    ['no labels', null],
    ['no marker', { 'openchamber.space.id': ID }],
    ['a wrong marker value', { ...buildSpaceLabels(FIELDS), 'openchamber.space': 'yes' }],
    ['a malformed id', { ...buildSpaceLabels(FIELDS), 'openchamber.space.id': 'A1' }],
    ['an unknown role', { ...buildSpaceLabels(FIELDS), 'openchamber.space.role': 'gateway' }],
    ['no owner', { ...buildSpaceLabels(FIELDS), 'openchamber.space.owner': undefined }],
  ])('returns null for %s', (title, labels) => {
    expect(parseSpaceLabels(labels)).toBeNull();
  });

  it('keeps a resource whose display labels are missing', () => {
    const parsed = parseSpaceLabels({ 'openchamber.space': 'true', 'openchamber.space.id': ID, 'openchamber.space.role': 'volume', 'openchamber.space.owner': 'install-a' });
    expect(parsed).toEqual({ id: ID, role: 'volume', owner: 'install-a', project: '', name: '', created: '' });
  });
});

describe('tools labels and names', () => {
  const KEY = '0123456789abcdef';
  const TOOLS_FIELDS = { role: 'tools', owner: 'install-a', key: KEY, description: 'web 1.24.2, opencode 1.18.31', created: '2026-09-20T08:00:00.000Z' };

  it('names the volume after the owner and the key, and a one-shot after the volume', () => {
    expect(toolsResourceName('install-a', KEY)).toBe(`openchamber-tools-install-a-${KEY}`);
    expect(toolsResourceName('install-a', KEY, 'tools-fill')).toBe(`openchamber-tools-install-a-${KEY}-fill`);
    expect(toolsResourceName('install-a', KEY, 'tools-check')).toBe(`openchamber-tools-install-a-${KEY}-check`);
  });

  it('rejects a bad owner, key or role in a name', () => {
    expect(() => toolsResourceName('a b', KEY)).toThrow(expect.objectContaining({ code: 'invalid_owner' }));
    expect(() => toolsResourceName('install-a', '../x')).toThrow(expect.objectContaining({ code: 'invalid_tools_key' }));
    expect(() => toolsResourceName('install-a', KEY, 'space')).toThrow(expect.objectContaining({ code: 'invalid_role' }));
  });

  it('reads the key back from a volume name of this owner only', () => {
    expect(toolsKeyFromVolumeName(`openchamber-tools-install-a-${KEY}`, 'install-a')).toBe(KEY);
    // An owner whose id is the start of another owner's id must not match that owner's volumes.
    expect(toolsKeyFromVolumeName(`openchamber-tools-install-a-${KEY}`, 'install')).toBeNull();
    expect(toolsKeyFromVolumeName(`openchamber-tools-install-b-${KEY}`, 'install-a')).toBeNull();
    expect(toolsKeyFromVolumeName(`openchamber-tools-install-a-${KEY}-fill`, 'install-a')).toBeNull();
    expect(toolsKeyFromVolumeName(`openchamber-space-${ID}-volume-work`, 'install-a')).toBeNull();
    expect(toolsKeyFromVolumeName(undefined, 'install-a')).toBeNull();
  });

  it('builds the marker, the owner, the role, the key, a description and the time, and no space id', () => {
    expect(buildToolsLabels(TOOLS_FIELDS)).toEqual({
      'openchamber.space': 'true',
      'openchamber.space.role': 'tools',
      'openchamber.space.owner': 'install-a',
      'openchamber.space.tools.key': KEY,
      'openchamber.space.tools.description': 'web 1.24.2, opencode 1.18.31',
      'openchamber.space.created': '2026-09-20T08:00:00.000Z',
    });
  });

  it.each([
    ['invalid_role', { role: 'volume' }],
    ['invalid_owner', { owner: 'a,b' }],
    ['invalid_tools_key', { key: 'ABCDEF0123456789' }],
    ['invalid_tools_description', { description: 'two\nlines' }],
    ['invalid_tools_description', { description: '' }],
    ['invalid_created', { created: 'soon' }],
  ])('rejects with %s', (code, change) => {
    expect(() => buildToolsLabels({ ...TOOLS_FIELDS, ...change })).toThrow(expect.objectContaining({ code }));
  });

  it('is invisible to the space label parser, so `list` and `remove` pass a tools volume by', () => {
    expect(parseSpaceLabels(buildToolsLabels(TOOLS_FIELDS))).toBeNull();
    expect(parseToolsLabels(buildSpaceLabels(FIELDS))).toBeNull();
  });

  it('round-trips through the tools label parser', () => {
    expect(parseToolsLabels(buildToolsLabels(TOOLS_FIELDS))).toEqual(TOOLS_FIELDS);
  });

  it.each([
    ['no labels', null],
    ['no marker', { ...buildToolsLabels(TOOLS_FIELDS), 'openchamber.space': undefined }],
    ['a malformed key', { ...buildToolsLabels(TOOLS_FIELDS), 'openchamber.space.tools.key': 'latest' }],
    ['no owner', { ...buildToolsLabels(TOOLS_FIELDS), 'openchamber.space.owner': undefined }],
  ])('returns null for %s', (title, labels) => {
    expect(parseToolsLabels(labels)).toBeNull();
  });

  it('filters by owner, and by role and key when asked', () => {
    expect(toolsLabelFilterArgs({ owner: 'install-a', role: 'tools' })).toEqual([
      '--filter', 'label=openchamber.space=true',
      '--filter', 'label=openchamber.space.owner=install-a',
      '--filter', 'label=openchamber.space.role=tools',
    ]);
    expect(toolsLabelFilterArgs({ owner: 'install-a', key: KEY })).toEqual([
      '--filter', 'label=openchamber.space=true',
      '--filter', 'label=openchamber.space.owner=install-a',
      '--filter', `label=openchamber.space.tools.key=${KEY}`,
    ]);
  });
});
