import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseMdFile, writeMdFile } from './shared.js';
import { updateAgent } from './agents.js';

const FIXTURE_DIR = path.join(os.tmpdir(), `openchamber-shared-test-${process.pid}`);

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

describe('writeMdFile', () => {
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
    expect(parsed.frontmatter).toEqual({
      description: 'Strategy agent',
      model: 'openai/gpt-5',
      temperature: 0.7,
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
      temperature: 0.7,
    });
    expect(parsed.body).toBe('Body of strateg.');
  });
});
