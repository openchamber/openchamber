import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendInstalledSources, isInstalledFromSource, readInstalledSources, removeInstalledSources } from './installed-sources.js';

let dataDir;
let previousDataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-installed-sources-'));
  previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const entry = (overrides = {}) => ({
  skillName: 'skill-creator',
  skillDir: 'skills/skill-creator',
  scope: 'user',
  source: 'opencode',
  sourceId: 'acme',
  sourceRef: 'acme/skills',
  ...overrides,
});

describe('installed skill provenance registry', () => {
  it('round-trips entries keyed by skill name', () => {
    appendInstalledSources([entry(), entry({ skillName: 'other', sourceId: 'other', skillDir: 'skills/other' })]);

    const byName = readInstalledSources();
    expect(byName.get('skill-creator')).toHaveLength(1);
    expect(byName.get('skill-creator')[0]).toMatchObject({ sourceId: 'acme', skillDir: 'skills/skill-creator' });
    expect(byName.get('other')[0]).toMatchObject({ sourceId: 'other' });
  });

  it('adds a second source for the same name and dedupes a reinstall', () => {
    appendInstalledSources([entry()]);
    appendInstalledSources([entry()]);
    appendInstalledSources([entry({ sourceId: 'other', sourceRef: 'other/skills' })]);

    const entries = readInstalledSources().get('skill-creator');
    expect(entries).toHaveLength(2);
    expect(entries.map((held) => held.sourceId)).toEqual(['acme', 'other']);
  });

  it('treats a missing or malformed file as no provenance', () => {
    expect(readInstalledSources().size).toBe(0);

    fs.writeFileSync(path.join(dataDir, 'skills-installed-sources.json'), '{broken');
    expect(readInstalledSources().size).toBe(0);

    fs.writeFileSync(path.join(dataDir, 'skills-installed-sources.json'), JSON.stringify({ version: 99, entries: [entry()] }));
    expect(readInstalledSources().size).toBe(0);
  });

  it('ignores entries that are missing their identity', () => {
    appendInstalledSources([entry({ sourceId: '' }), { skillName: '', skillDir: 'x', sourceId: 'a' }, entry({ skillDir: '' })]);

    expect(readInstalledSources().size).toBe(0);
  });

  it('appends nothing when every entry is invalid', () => {
    appendInstalledSources([{ nope: true }]);

    expect(fs.existsSync(path.join(dataDir, 'skills-installed-sources.json'))).toBe(false);
  });

  it('forgets every entry of a deleted skill and keeps the rest', () => {
    appendInstalledSources([entry(), entry({ sourceId: 'other' }), entry({ skillName: 'kept', skillDir: 'skills/kept' })]);

    removeInstalledSources('skill-creator');

    const byName = readInstalledSources();
    expect(byName.has('skill-creator')).toBe(false);
    expect(byName.get('kept')).toHaveLength(1);
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('narrows the badge to recorded sources and falls back to the name without records', () => {
    appendInstalledSources([entry()]);
    const byName = readInstalledSources();

    expect(isInstalledFromSource(byName, 'skill-creator', 'acme', 'skills/skill-creator')).toBe(true);
    expect(isInstalledFromSource(byName, 'skill-creator', 'other', 'skills/skill-creator')).toBe(false);
    expect(isInstalledFromSource(byName, 'unrecorded', 'any', 'skills/unrecorded')).toBe(true);
  });
});
