import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSnippet,
  deleteSnippet,
  expandSnippets,
  getSnippet,
  listSnippets,
  SNIPPET_FILE_MAX_BYTES,
  previewSnippet,
  updateSnippet,
} from './snippets.js';

let projectDir;

function writeSnippet(relativePath, content) {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('snippets', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-snippets-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('loads project snippets with aliases and description', () => {
    writeSnippet('.opencode/snippet/review.md', '---\naliases: [rev]\ndescription: Review helper\n---\nReview carefully.');

    expect(listSnippets(projectDir)).toContainEqual(
      expect.objectContaining({ name: 'review', aliases: ['rev'], description: 'Review helper', source: 'project' }),
    );
    expect(getSnippet('rev', projectDir)).toEqual(expect.objectContaining({ name: 'review' }));
  });

  test('snippet directory wins over snippets directory', () => {
    writeSnippet('.opencode/snippets/same.md', 'Old');
    writeSnippet('.opencode/snippet/same.md', 'New');

    expect(getSnippet('same', projectDir)?.content).toBe('New');
  });

  test('canonical snippet names take precedence over colliding aliases', () => {
    writeSnippet('.opencode/snippets/review.md', 'Review by name');
    writeSnippet('.opencode/snippet/helper.md', '---\naliases: [review, help]\n---\nReview by alias');

    expect(getSnippet('review', projectDir)).toEqual(expect.objectContaining({ name: 'review', content: 'Review by name' }));
    expect(getSnippet('help', projectDir)).toEqual(expect.objectContaining({ name: 'helper', content: 'Review by alias' }));
    expect(expandSnippets('Use #review and #help', projectDir)).toBe('Use Review by name and Review by alias');
  });

  test('canonical snippet names override earlier same-directory aliases', () => {
    writeSnippet('.opencode/snippet/alias-first.md', '---\naliases: [review, assist]\n---\nReview by alias');
    writeSnippet('.opencode/snippet/review.md', 'Review by name');

    const snippetDir = path.join(projectDir, '.opencode', 'snippet');
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = function readdirSync(dir, ...args) {
      if (dir === snippetDir) return ['alias-first.md', 'review.md'];
      return originalReaddirSync.call(fs, dir, ...args);
    };

    try {
      expect(getSnippet('review', projectDir)).toEqual(expect.objectContaining({ name: 'review', content: 'Review by name' }));
      expect(getSnippet('assist', projectDir)).toEqual(expect.objectContaining({ name: 'alias-first', content: 'Review by alias' }));
      expect(expandSnippets('Use #review and #assist', projectDir)).toBe('Use Review by name and Review by alias');
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });

  test('skips oversized snippets without reading them and keeps siblings available', () => {
    const oversizedPath = path.join(projectDir, '.opencode', 'snippet', 'oversized.md');
    fs.mkdirSync(path.dirname(oversizedPath), { recursive: true });
    fs.writeFileSync(oversizedPath, '');
    fs.truncateSync(oversizedPath, SNIPPET_FILE_MAX_BYTES + 1);
    writeSnippet('.opencode/snippet/available.md', 'Available text');

    const originalReadFileSync = fs.readFileSync;
    const originalWarn = console.warn;
    const reads = [];
    const warnings = [];
    fs.readFileSync = function readFileSync(filePath, ...args) {
      if (filePath === oversizedPath) reads.push(filePath);
      return originalReadFileSync.call(fs, filePath, ...args);
    };
    console.warn = (...args) => warnings.push(args);

    try {
      expect(listSnippets(projectDir).map((snippet) => snippet.name)).toEqual(['available']);
      expect(getSnippet('available', projectDir)?.content).toBe('Available text');
      expect(expandSnippets('Use #available', projectDir)).toBe('Use Available text');
      expect(reads).toEqual([]);
      expect(warnings.some(([message]) => String(message).includes(oversizedPath))).toBe(true);
    } finally {
      fs.readFileSync = originalReadFileSync;
      console.warn = originalWarn;
    }
  });

  test('accepts snippet files exactly at the byte cap', () => {
    const content = 'x'.repeat(SNIPPET_FILE_MAX_BYTES);
    const filePath = path.join(projectDir, '.opencode', 'snippet', 'at-cap.md');
    writeSnippet('.opencode/snippet/at-cap.md', content);

    expect(fs.statSync(filePath).size).toBe(SNIPPET_FILE_MAX_BYTES);
    expect(getSnippet('at-cap', projectDir)?.content).toBe(content);
    expect(expandSnippets('#at-cap', projectDir)).toBe(content);
  });

  test('refuses to create a snippet past the byte cap and writes nothing', () => {
    const filePath = path.join(projectDir, '.opencode', 'snippet', 'too-big.md');
    expect(() => createSnippet('too-big', { content: 'x'.repeat(SNIPPET_FILE_MAX_BYTES + 1) }, projectDir, 'project')).toThrow('-byte limit');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('refuses an update past the byte cap and preserves the existing snippet', () => {
    createSnippet('keep-me', { content: 'Original' }, projectDir, 'project');
    const filePath = path.join(projectDir, '.opencode', 'snippet', 'keep-me.md');
    const before = fs.readFileSync(filePath, 'utf8');
    expect(() => updateSnippet('keep-me', { content: 'y'.repeat(SNIPPET_FILE_MAX_BYTES + 1) }, projectDir)).toThrow('-byte limit');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(getSnippet('keep-me', projectDir)?.content).toBe('Original');
  });

  test('creates updates and deletes snippets', () => {
    expect(createSnippet('custom-one', { content: 'Body', aliases: ['co'] }, projectDir, 'project')).toEqual(
      expect.objectContaining({ name: 'custom-one', content: 'Body', aliases: ['co'] }),
    );
    expect(updateSnippet('custom-one', { content: 'Updated' }, projectDir)).toEqual(
      expect.objectContaining({ name: 'custom-one', content: 'Updated', aliases: ['co'] }),
    );
    deleteSnippet('custom-one', projectDir);
    expect(getSnippet('custom-one', projectDir)).toBeNull();
  });

  test('expands snippets recursively with prepend and append blocks', () => {
    writeSnippet('.opencode/snippet/base.md', 'Base text');
    writeSnippet('.opencode/snippet/review.md', '<prepend>Before</prepend>Review #base<append>After</append>');

    expect(expandSnippets('Please #review', projectDir)).toBe('Before\n\nPlease Review Base text\n\nAfter');
  });

  test('refuses a new snippet under a name or alias already in use', () => {
    writeSnippet('.opencode/snippet/review.md', '---\naliases: [rev]\n---\nOriginal');

    expect(() => createSnippet('review', { content: 'Other' }, projectDir, 'project')).toThrow('already exists');
    expect(() => createSnippet('rev', { content: 'Other' }, projectDir, 'project')).toThrow('already exists');
    expect(getSnippet('review', projectDir)?.content).toBe('Original');
  });

  test('renames a snippet with its fields', () => {
    writeSnippet('.opencode/snippet/old-name.md', '---\naliases: [on]\n---\nBody');

    expect(updateSnippet('old-name', { name: 'new-name', content: 'Changed' }, projectDir)).toEqual(
      expect.objectContaining({ name: 'new-name', content: 'Changed', aliases: ['on'], source: 'project' }),
    );
    expect(fs.existsSync(path.join(projectDir, '.opencode', 'snippet', 'old-name.md'))).toBe(false);
    expect(getSnippet('on', projectDir)).toEqual(expect.objectContaining({ name: 'new-name' }));
  });

  test('renames a snippet by case alone', () => {
    writeSnippet('.opencode/snippet/fix-pr.md', 'Body');

    expect(updateSnippet('fix-pr', { name: 'Fix-PR' }, projectDir)).toEqual(expect.objectContaining({ name: 'Fix-PR', content: 'Body' }));
    expect(fs.readdirSync(path.join(projectDir, '.opencode', 'snippet'))).toEqual(['Fix-PR.md']);
  });

  test('refuses a rename onto a name or alias in use and keeps the snippet', () => {
    writeSnippet('.opencode/snippet/first.md', 'One');
    writeSnippet('.opencode/snippet/second.md', '---\naliases: [two]\n---\nTwo');

    expect(() => updateSnippet('first', { name: 'second', content: 'Lost' }, projectDir)).toThrow('already exists');
    expect(() => updateSnippet('first', { name: 'two' }, projectDir)).toThrow('already exists');
    expect(getSnippet('first', projectDir)?.content).toBe('One');
    expect(getSnippet('second', projectDir)?.content).toBe('Two');
  });

  test('previews an unsaved body with its blocks and the snippets it names', () => {
    const body = '<prepend>Before</prepend>Use #base<append>After</append>';
    writeSnippet('.opencode/snippet/base.md', '<append>Base after</append>Base text');

    expect(previewSnippet(body, projectDir)).toBe('Before\n\nUse Base text\n\nAfter\n\nBase after');
    // The same body saved and used sends the same text.
    writeSnippet('.opencode/snippet/saved.md', body);
    expect(expandSnippets('#saved', projectDir)).toBe(previewSnippet(body, projectDir));
  });

  test('rejects invalid snippet names', () => {
    expect(() => createSnippet('../bad', { content: '' }, projectDir, 'project')).toThrow('Snippet name');
  });
});
