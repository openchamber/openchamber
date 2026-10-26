import { describe, expect, test } from 'bun:test';

import { splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  test('reads a YAML mapping into properties and keeps the body', () => {
    const { frontmatter, body } = splitFrontmatter([
      '---',
      'title: Release plan',
      'draft: true',
      'tags: [docs, release]',
      'owner:',
      '  name: Ana',
      'empty:',
      '---',
      '# Heading',
    ].join('\n'));

    expect(body).toBe('# Heading');
    expect(frontmatter).toEqual({
      kind: 'properties',
      properties: [
        { key: 'title', value: { kind: 'text', text: 'Release plan' } },
        { key: 'draft', value: { kind: 'text', text: 'true' } },
        { key: 'tags', value: { kind: 'list', items: ['docs', 'release'] } },
        { key: 'owner', value: { kind: 'code', text: 'name: Ana' } },
        { key: 'empty', value: { kind: 'text', text: '' } },
      ],
    });
  });

  test('handles a byte order mark and CRLF line endings', () => {
    const { frontmatter, body } = splitFrontmatter('\uFEFF---\r\nname: x\r\n---\r\nBody');
    expect(body).toBe('Body');
    expect(frontmatter).toEqual({ kind: 'properties', properties: [{ key: 'name', value: { kind: 'text', text: 'x' } }] });
  });

  test('keeps TOML, invalid YAML and non-mapping YAML as written', () => {
    expect(splitFrontmatter('+++\ntitle = "x"\n+++\nBody').frontmatter).toEqual({ kind: 'raw', text: 'title = "x"' });
    expect(splitFrontmatter('---\nkey: [unclosed\n---\nBody').frontmatter).toEqual({ kind: 'raw', text: 'key: [unclosed' });
    expect(splitFrontmatter('---\n- a\n- b\n---\nBody').frontmatter).toEqual({ kind: 'raw', text: '- a\n- b' });
  });

  test('a block of only comments shows nothing', () => {
    expect(splitFrontmatter('---\n# nothing here\n---\nBody')).toEqual({ frontmatter: null, body: 'Body' });
  });

  test('a document without frontmatter is left alone', () => {
    expect(splitFrontmatter('# Title\n\n---\n\ntext')).toEqual({ frontmatter: null, body: '# Title\n\n---\n\ntext' });
  });
});
