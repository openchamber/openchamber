import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MD_FILE_MAX_BYTES, parseMdFile, parseMdFileAsync, writeMdFile } from './markdown-files.js';
import { readConfigFile, writeConfig } from './config-files.js';
import { updateAgent } from './agents.js';

const FIXTURE_DIR = path.join(os.tmpdir(), `openchamber-markdown-files-test-${process.pid}`);

const STANDARD_MD = [
  '---',
  'description: My build agent',
  'model: anthropic/claude-sonnet-4',
  'mode: primary',
  '---',
  '',
  'This is the prompt body.',
  '',
].join('\n');

const writeFixture = (name, content) => {
  const filePath = path.join(FIXTURE_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};
describe('ordered config maps', () => {
  // Oracle: a parsed read retains the requested sequence; comments and sibling
  // config text survive a reorder without a semantic value change.
  it('persists a pool reorder and keeps comments inside each value', () => {
    const filePath = writeFixture('ordered-pools.jsonc', '{\n  // keep sibling\n  "model": "p/m",\n  "experimental": { "model_routes": {\n    "fast": { /* fast note */ "targets": ["p/a"] },\n    "slow": { /* slow note */ "targets": ["p/b"] }\n  } }\n}');
    const original = readConfigFile(filePath);
    writeConfig({ ...original, experimental: { model_routes: {
      slow: original.experimental.model_routes.slow, fast: original.experimental.model_routes.fast,
    } } }, filePath, { orderedPaths: [['experimental', 'model_routes']] });
    expect(Object.keys(readConfigFile(filePath).experimental.model_routes)).toEqual(['slow', 'fast']);
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('// keep sibling');
    expect(text).toContain('"slow": { /* slow note */');
    expect(text).toContain('"fast": { /* fast note */');
    expect(readConfigFile(filePath).model).toBe('p/m');
  });
});

describe('parseMdFile', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('parses standard YAML frontmatter', () => {
    const file = writeFixture('standard.md', STANDARD_MD);
    const { frontmatter, body } = parseMdFile(file);
    expect(frontmatter).toEqual({
      description: 'My build agent',
      model: 'anthropic/claude-sonnet-4',
      mode: 'primary',
    });
    expect(body).toBe('This is the prompt body.');
  });

  it('parses frontmatter whose closing --- is at end-of-file without a trailing newline', () => {
    // gray-matter (used by OpenCode) accepts this shape; OpenChamber must too,
    // otherwise a later save duplicates the YAML block.
    const file = writeFixture('eof-close.md', [
      '---',
      'description: My build agent',
      'model: anthropic/claude-sonnet-4',
      '---',
    ].join('\n'));
    const { frontmatter, body } = parseMdFile(file);
    expect(frontmatter).toEqual({
      description: 'My build agent',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(body).toBe('');
  });

  it('parses frontmatter with CRLF line endings', () => {
    const file = writeFixture('crlf.md', STANDARD_MD.replace(/\n/g, '\r\n'));
    const { frontmatter, body } = parseMdFile(file);
    expect(frontmatter.model).toBe('anthropic/claude-sonnet-4');
    expect(body).toBe('This is the prompt body.');
  });

  it('parses frontmatter preceded by a UTF-8 BOM', () => {
    const file = writeFixture('bom.md', `\uFEFF${STANDARD_MD}`);
    const { frontmatter, body } = parseMdFile(file);
    expect(frontmatter.description).toBe('My build agent');
    expect(body).toBe('This is the prompt body.');
  });

  it('falls back to lenient YAML for unquoted colons in values, matching OpenCode', () => {
    const file = writeFixture('colon.md', [
      '---',
      'description: Build agent: creates builds',
      'model: anthropic/claude-sonnet-4',
      '---',
      '',
      'Body',
      '',
    ].join('\n'));
    const { frontmatter, body } = parseMdFile(file);
    expect(frontmatter).toEqual({
      description: 'Build agent: creates builds',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(body).toBe('Body');
  });

  it('treats files without frontmatter as a plain body', () => {
    const file = writeFixture('plain.md', 'Just a prompt body.');
    const { frontmatter, body } = parseMdFile(file);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a prompt body.');
  });
});
describe('parseMdFile size gate (#1143)', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('exports a positive named cap', () => {
    expect(MD_FILE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it('refuses an over-cap file on the sync helper without parsing it', () => {
    const file = writeFixture('over-cap.md', 'a'.repeat(MD_FILE_MAX_BYTES + 1));
    expect(() => parseMdFile(file)).toThrow(/exceeds the .* size limit/);
    try {
      parseMdFile(file);
      expect.unreachable();
    } catch (error) {
      expect(error.code).toBe('ERR_MD_FILE_TOO_LARGE');
    }
  });

  it('refuses an over-cap file on the async helper without parsing it', async () => {
    const file = writeFixture('over-cap-async.md', 'a'.repeat(MD_FILE_MAX_BYTES + 1));
    await expect(parseMdFileAsync(file)).rejects.toThrow(/exceeds the .* size limit/);
    await expect(parseMdFileAsync(file)).rejects.toMatchObject({ code: 'ERR_MD_FILE_TOO_LARGE' });
  });

  it('parses a file exactly at the cap byte-identically on both helpers', async () => {
    const content = 'a'.repeat(MD_FILE_MAX_BYTES);
    const file = writeFixture('at-cap.md', content);
    expect(fs.statSync(file).size).toBe(MD_FILE_MAX_BYTES);
    expect(parseMdFile(file).body).toBe(content);
    expect((await parseMdFileAsync(file)).body).toBe(content);
  });

  it('keeps missing-file behaviour unchanged on both helpers', async () => {
    const missing = path.join(FIXTURE_DIR, 'missing.md');
    expect(() => parseMdFile(missing)).toThrow(/ENOENT/);
    await expect(parseMdFileAsync(missing)).rejects.toThrow(/ENOENT/);
  });

  it('parses ordinary frontmatter files through the async helper', async () => {
    const file = writeFixture('standard-async.md', STANDARD_MD);
    const { frontmatter, body } = await parseMdFileAsync(file);
    expect(frontmatter.description).toBe('My build agent');
    expect(body).toBe('This is the prompt body.');
  });
});


describe('writeMdFile', () => {
  it('refuses a serialized result over the parse cap and leaves the file unchanged (#1444)', () => {
    const file = writeFixture('over-cap.md', STANDARD_MD);
    const before = fs.readFileSync(file, 'utf8');
    let error;
    try {
      writeMdFile(file, { description: 'My build agent' }, 'x'.repeat(MD_FILE_MAX_BYTES));
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe('ERR_MD_FILE_TOO_LARGE');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes a serialized result exactly at the parse cap and reads it back (#1444)', () => {
    const file = writeFixture('at-cap-write.md', STANDARD_MD);
    const frontmatter = { description: 'My build agent' };
    writeMdFile(file, frontmatter, 'x');
    const overhead = fs.statSync(file).size - 1;
    const body = 'x'.repeat(MD_FILE_MAX_BYTES - overhead);
    writeMdFile(file, frontmatter, body);
    expect(fs.statSync(file).size).toBe(MD_FILE_MAX_BYTES);
    expect(parseMdFile(file).body).toBe(body);
  });

  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('round-trips a canonical single frontmatter block', () => {
    const file = writeFixture('roundtrip.md', STANDARD_MD);
    const parsed = parseMdFile(file);
    parsed.frontmatter.model = 'openai/gpt-5';
    writeMdFile(file, parsed.frontmatter, parsed.body);

    const content = fs.readFileSync(file, 'utf8');
    // Exactly one frontmatter block.
    expect(content.match(/^---\r?\n/g)).toHaveLength(1);

    const reparsed = parseMdFile(file);
    expect(reparsed.frontmatter).toEqual({
      description: 'My build agent',
      model: 'openai/gpt-5',
      mode: 'primary',
    });
    expect(reparsed.body).toBe('This is the prompt body.');
  });
});

describe('updateAgent frontmatter preservation', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('updates the model in place without duplicating YAML for a file with EOF-closed frontmatter', () => {
    // Repro of OPE-178: the file's closing --- sits at EOF (no trailing
    // newline). OpenCode parses it; OpenChamber previously treated the whole
    // file as the prompt body and prepended a second frontmatter block on save.
    const projectDir = path.join(FIXTURE_DIR, 'project');
    const agentPath = path.join(projectDir, '.opencode', 'agents', 'strateg.md');
    writeFixture(path.join('project', '.opencode', 'agents', 'strateg.md'), [
      '---',
      'description: Strategy agent',
      'model: anthropic/claude-sonnet-4',
      'temperature: 0.7',
      '---',
    ].join('\n'));

    updateAgent('strateg', { model: 'openai/gpt-5' }, projectDir);

    const content = fs.readFileSync(agentPath, 'utf8');
    expect(content.match(/^---\r?\n/g)).toHaveLength(1);

    const parsed = parseMdFile(agentPath);
    // `temperature` is a v1 field: reading accepts it, writing moves it under
    // the v2 `request.body` overlay.
    expect(parsed.frontmatter).toEqual({
      description: 'Strategy agent',
      model: 'openai/gpt-5',
      request: { body: { temperature: 0.7 } },
    });
    expect(parsed.body).toBe('');
  });

  it('preserves unrelated frontmatter fields when saving one field', () => {
    const projectDir = path.join(FIXTURE_DIR, 'project');
    const agentPath = path.join(projectDir, '.opencode', 'agents', 'strateg.md');
    writeFixture(path.join('project', '.opencode', 'agents', 'strateg.md'), [
      '---',
      'description: Strategy agent',
      'mode: primary',
      'temperature: 0.7',
      '---',
      '',
      'Body of strateg.',
      '',
    ].join('\n'));

    updateAgent('strateg', { description: 'Updated strategy agent' }, projectDir);

    const content = fs.readFileSync(agentPath, 'utf8');
    expect(content.match(/^---\r?\n/g)).toHaveLength(1);

    const parsed = parseMdFile(agentPath);
    expect(parsed.frontmatter).toEqual({
      description: 'Updated strategy agent',
      mode: 'primary',
      request: { body: { temperature: 0.7 } },
    });
    expect(parsed.body).toBe('Body of strateg.');
  });
});
