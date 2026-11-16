import { expect, test } from 'bun:test';

import { buildTurnMarkdown, buildTurnMarkdownFilename } from './useAssistantMarkdownSave';

test('buildTurnMarkdown joins earlier and current segments', () => {
  expect(buildTurnMarkdown(['a'], [{ type: 'text', text: 'b' }] as never)).toBe('a\n\nb');
});

test('buildTurnMarkdownFilename uses message id', () => {
  expect(buildTurnMarkdownFilename('m1')).toBe('message-m1.md');
});
