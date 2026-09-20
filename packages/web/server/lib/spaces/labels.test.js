import { describe, expect, it } from 'vitest';

import {
  buildSpaceLabels,
  createSpaceId,
  hashProjectDirectory,
  isSpaceId,
  labelArgs,
  labelFilterArgs,
  normalizeSpaceName,
  parseSpaceLabels,
  spaceResourceName,
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
