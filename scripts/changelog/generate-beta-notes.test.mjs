import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractUnreleasedNotes, generateBetaNotes } from './generate-beta-notes.mjs';

test('extractUnreleasedNotes extracts highlights from unreleased.md file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-notes-test-'));
  const file = path.join(tmpDir, 'unreleased.md');
  fs.writeFileSync(
    file,
    '---\ntitle: Feature Beta\n---\n\n## App\n\n### New\n- Add beta channel support in settings.\n\n### Fixes\n- Fix safe navigation fallback.\n'
  );

  const notes = extractUnreleasedNotes(file);
  assert.match(notes, /### New/);
  assert.match(notes, /- Add beta channel support in settings\./);
  assert.match(notes, /### Fixes/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('generateBetaNotes formats version, highlights and commit list', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-notes-test-'));
  const unreleasedFile = path.join(tmpDir, 'unreleased.md');
  fs.writeFileSync(
    unreleasedFile,
    '---\ntitle: Feature Beta\n---\n\n## App\n\n### Improvements\n- Better update checks.\n'
  );

  const result = generateBetaNotes({
    version: '1.24.0-beta.5',
    build: '105',
    unreleasedFile,
  });

  assert.match(result, /Automated beta build #105 \(1\.24\.0-beta\.5\)/);
  assert.match(result, /### 🌟 Upcoming Release Highlights/);
  assert.match(result, /- Better update checks\./);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
