import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// Conformance for the quota provider manifest (design #1808, phase 1 #1809):
// the web registry and the DOCUMENTATION.md dispatcher table are surfaces of
// the one logical provider set the manifest states. A provider that appears
// in a list but not the manifest fails, and so does a manifest provider
// silently absent from a list - a surface absence is only ever a named
// exception in the manifest, never a silent one (contract rule 2).

const here = path.dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'provider-manifest.json'), 'utf8'));

const expectedFor = (surface) => new Set(
  [...manifest.providers, ...manifest.aliases]
    .filter((row) => row.surfaces[surface])
    .map((row) => row.id)
);

// Registry keys are the dispatchable provider ids. The registry object is
// not exported, so the keys are read from its source block: top-level keys
// of the `const registry = { ... }` literal, in the same shape the python
// and sibling conformance extractions use.
const registryIds = () => {
  const source = fs.readFileSync(path.join(here, 'providers/index.js'), 'utf8');
  const start = source.indexOf('const registry = {');
  const lines = source.slice(start).split('\n');
  const ids = [];
  let depth = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (depth === 1) {
      const match = stripped.match(/^(?:'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*\{/);
      if (match) ids.push(match[1] ?? match[2]);
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0 && ids.length > 0) break;
  }
  return new Set(ids);
};

const docsTableIds = () => {
  const doc = fs.readFileSync(path.join(here, 'DOCUMENTATION.md'), 'utf8');
  const start = doc.indexOf('## Supported provider IDs');
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const ids = new Set();
  for (const line of section.split('\n')) {
    if (line.startsWith('| `')) {
      ids.add(line.split('|')[1].trim().replaceAll('`', ''));
    }
  }
  return ids;
};

describe('quota provider manifest (web)', () => {
  it('the web registry is exactly the manifest web surface', () => {
    expect(registryIds()).toEqual(expectedFor('web'));
  });

  it('the DOCUMENTATION.md dispatcher table is exactly the manifest docs surface', () => {
    expect(docsTableIds()).toEqual(expectedFor('docs'));
  });

  it('every non-uniform provider carries a named exception with an adopting issue', () => {
    for (const row of manifest.providers) {
      expect(row.name, row.id).toBeTruthy();
      const absentFrom = Object.entries(row.surfaces)
        .filter(([, present]) => !present)
        .map(([surface]) => surface);
      if (absentFrom.length === 0) {
        expect(row.exception, row.id).toBeUndefined();
      } else {
        expect(row.exception, row.id).toBeTruthy();
        expect(row.exception.absent_from).toEqual(absentFrom);
        expect(Number.isInteger(row.exception.issue), row.id).toBe(true);
        expect(row.exception.reason, row.id).toBeTruthy();
      }
    }
  });

  it('aliases are recorded as aliases, never as providers', () => {
    const providerIds = new Set(manifest.providers.map((row) => row.id));
    for (const alias of manifest.aliases) {
      expect(providerIds.has(alias.id)).toBe(false);
      expect(providerIds.has(alias.alias_of)).toBe(true);
    }
  });
});
