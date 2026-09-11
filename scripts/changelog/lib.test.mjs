import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadReleases, parseRelease, promoteUnreleased, renderAppChangelog, renderIndex, renderOutputs, renderReleaseNotes, renderVsCodeChangelog } from './lib.mjs';

const release = `---
version: 1.2.3
date: 2026-01-31
title: Comments everywhere
---

A short intro.

## App

### Fixes
- Chat: huge patches open without freezing the page (thanks to @someone).

### New
- **Comments:** select text and comment on it.

## VS Code

### New
- Comments on code.
`;

test('parses front matter, intro, sections, and groups', () => {
  const parsed = parseRelease(release, 'changelog/1.2.3.md');
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.date, '2026-01-31');
  assert.equal(parsed.title, 'Comments everywhere');
  assert.deepEqual(parsed.intro, ['A short intro.']);
  assert.deepEqual(parsed.app, {
    Fixes: ['Chat: huge patches open without freezing the page (thanks to @someone).'],
    New: ['**Comments:** select text and comment on it.'],
  });
  assert.deepEqual(parsed.vscode, { New: ['Comments on code.'] });
});

test('rejects shapes the generator cannot render', () => {
  assert.throws(() => parseRelease('## App\n### Nope\n- x\n', 'f.md'), /unknown group "Nope"/);
  assert.throws(() => parseRelease('## Desktop\n', 'f.md'), /unknown section "Desktop"/);
  assert.throws(() => parseRelease('- orphan\n', 'f.md'), /must sit under a ### group/);
  assert.throws(() => parseRelease('## App\n### New\nstray text\n', 'f.md'), /unexpected text inside a section/);
  assert.throws(() => parseRelease('---\nversion: 1.2\ndate: 2026-01-31\n---\n', 'f.md'), /is not x\.y\.z/);
});

test('renders released versions only, groups in canonical order, and skips versions without a VS Code section', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(directory, '1.2.3.md'), release);
  fs.writeFileSync(path.join(directory, '1.2.4.md'), '---\nversion: 1.2.4\ndate: 2026-02-01\ntitle: Faster\n---\n\n## App\n\n### Improvements\n- Faster.\n');
  fs.writeFileSync(path.join(directory, 'unreleased.md'), '---\ntitle: Pending\n---\n\n## App\n\n### Fixes\n- Pending fix.\n\n## VS Code\n');
  const loaded = loadReleases(directory);

  const app = renderAppChangelog(loaded);
  assert.match(app, /^# Changelog\n\n<!-- Legacy copy for app versions up to 1\.22\.1/);
  assert.equal(app.slice(app.indexOf('## [1.2.4]')), `## [1.2.4] - 2026-02-01

### Improvements

- Faster.

## [1.2.3] - 2026-01-31

A short intro.

### New

- **Comments:** select text and comment on it.

### Fixes

- Chat: huge patches open without freezing the page (thanks to @someone).
`);
  assert.equal(app.includes('Unreleased'), false);

  assert.equal(renderVsCodeChangelog(loaded), `## [1.2.3] - 2026-01-31

### New

- Comments on code.
`);

  assert.equal(renderReleaseNotes(loaded.releases[1]), `A short intro.

### New

- **Comments:** select text and comment on it.

### Fixes

- Chat: huge patches open without freezing the page (thanks to @someone).
`);

  const index = JSON.parse(renderIndex(loaded));
  assert.equal(index.length, 2);
  assert.equal(index[0].version, '1.2.4');
  assert.equal(index[1].title, 'Comments everywhere');
  assert.deepEqual(index[1].vscode, { new: ['Comments on code.'], improvements: [], fixes: [], misc: [] });
  assert.equal(index[0].vscode, null);

  assert.deepEqual(Object.keys(renderOutputs(loaded)), ['packages/vscode/CHANGELOG.md', 'changelog/index.json']);
  assert.deepEqual(Object.keys(renderOutputs(loaded, { legacyAppChangelog: true })), ['CHANGELOG.md', 'packages/vscode/CHANGELOG.md', 'changelog/index.json']);
});

test('loadReleases refuses a file whose name and version disagree, and a release without a title', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(directory, '9.9.9.md'), release);
  assert.throws(() => loadReleases(directory), /does not match the file name 9\.9\.9/);
  fs.unlinkSync(path.join(directory, '9.9.9.md'));
  fs.writeFileSync(path.join(directory, '1.0.0.md'), '---\nversion: 1.0.0\ndate: 2026-02-01\n---\n\n## App\n\n### Fixes\n- x.\n');
  assert.throws(() => loadReleases(directory), /needs a title/);
});

test('promoteUnreleased dates and titles the release, resets the template, and refuses an empty or untitled release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  fs.writeFileSync(path.join(directory, 'unreleased.md'), '---\ntitle: Something shipped\n---\n\n## App\n\n### New\n- Something shipped.\n\n## VS Code\n');
  const created = promoteUnreleased(directory, '2.0.0', '2026-03-01');
  assert.equal(path.basename(created), '2.0.0.md');
  assert.match(fs.readFileSync(created, 'utf8'), /^---\nversion: 2\.0\.0\ndate: 2026-03-01\ntitle: Something shipped\n---\n\n## App/);
  assert.equal(fs.readFileSync(path.join(directory, 'unreleased.md'), 'utf8'), '---\ntitle:\n---\n\n## App\n\n## VS Code\n');
  assert.throws(() => promoteUnreleased(directory, '2.0.1', '2026-03-02'), /has no bullets/);
  fs.writeFileSync(path.join(directory, 'unreleased.md'), '## App\n\n### New\n- Untitled.\n');
  assert.throws(() => promoteUnreleased(directory, '2.0.1', '2026-03-02'), /has no title/);
});
