import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A `SelectValue` without children shows the selected value itself, not the
// option's label (Base UI reads labels only from `items`, which we do not
// pass). That is right only where the value is what the option shows: a
// branch, remote, voice or timezone name. Anywhere else the trigger has to
// render the label as children.
const VALUE_IS_LABEL = [
  'components/multirun/BranchSelector.tsx',
  'components/sections/git-identities/GitIdentityEditorDialog.tsx',
  'components/sections/openchamber/RepositoryBindingEditors.tsx',
  'components/sections/openchamber/VoiceSettings.tsx',
  'components/session/ScheduledTaskEditorDialog.tsx',
  'components/session/ScheduledTaskEditorDialog.tsx',
  'components/session/ScheduledTaskEditorDialog.tsx',
  'components/views/git/PublishDialog.tsx',
  'components/views/git/PublishDialog.tsx',
  'components/views/git/PublishDialog.tsx',
  'components/views/git/PullRequestSection.tsx',
];

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return sourceFiles(path);
  return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
});

/** Each `<SelectValue ... />` that closes itself, by file; `=>` inside props is not the tag's end. */
const selfClosingSelectValues = (source: string): number => {
  let count = 0;
  for (let start = source.indexOf('<SelectValue'); start !== -1; start = source.indexOf('<SelectValue', start + 1)) {
    let end = start;
    do end = source.indexOf('>', end + 1); while (end !== -1 && source[end - 1] === '=');
    if (end !== -1 && source[end - 1] === '/') count += 1;
  }
  return count;
};

describe('select triggers', () => {
  test('show the option label wherever the value differs from it', () => {
    const found = sourceFiles(SRC).flatMap((file) => {
      const count = selfClosingSelectValues(readFileSync(file, 'utf-8'));
      return Array.from({ length: count }, () => relative(SRC, file).split('\\').join('/'));
    });
    expect(found.sort()).toEqual([...VALUE_IS_LABEL].sort());
  });
});
