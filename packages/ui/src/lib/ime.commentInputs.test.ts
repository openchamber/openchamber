import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every place a user writes a comment submits on a bare Enter, and Enter is
 * also how an IME confirms a candidate. Without a composition guard the first
 * confirmation posts the half-typed reading and closes the input, so the guard
 * is a contract across all of these surfaces rather than a per-component
 * detail. `keyCode === 229` is part of it: WebKit reports the confirming Enter
 * that way after `compositionend`.
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMENT_INPUTS: Array<{ name: string; file: string; handler: string; guard: RegExp }> = [
  {
    // Chat quote comments and editing a pending comment above the composer
    // type into this field.
    name: 'comment text field',
    file: 'components/comments/CommentTextEditor.tsx',
    handler: 'const handleKeyDown',
    guard: /isIMECompositionEvent\(event\)\) return false;/,
  },
  {
    // Diff, file editor and file preview comments: a textarea, since the field
    // lives inside other editors' DOM.
    name: 'inline line comment',
    file: 'components/comments/InlineCommentInput.tsx',
    handler: 'const handleKeyDown',
    guard: /isIMECompositionEvent\(event\)\) return;/,
  },
  {
    name: 'issues and PRs board reply',
    file: 'components/sourceBoard/SourceBoardReply.tsx',
    handler: 'const onKeyDown',
    guard: /isIMECompositionEvent\(event\)\) return;/,
  },
  {
    name: 'browser annotation input',
    file: 'lib/browser/annotationOverlay.ts',
    handler: 'var onCommentKeyDown = function (event) {',
    guard: /event\.isComposing \|\| event\.keyCode === 229\) return;/,
  },
  {
    name: 'browser annotation escape',
    file: 'lib/browser/annotationOverlay.ts',
    handler: 'var onKeyDown = function (event) {',
    guard: /event\.isComposing \|\| event\.keyCode === 229\) return;/,
  },
];

describe('comment inputs ignore IME composition keystrokes', () => {
  for (const input of COMMENT_INPUTS) {
    test(input.name, () => {
      const source = readFileSync(join(srcDir, input.file), 'utf-8');
      const start = source.indexOf(input.handler);
      expect(start).toBeGreaterThan(-1);

      // From the input to the end of its key handler; the selection comment's
      // input carries change, select and paste handlers before it.
      const handler = source.slice(start, start + 1500);
      const guardIndex = handler.search(input.guard);
      const keyIndex = handler.search(/(event|e)\.key === '(Enter|Escape)'/);

      expect(guardIndex).toBeGreaterThan(-1);
      expect(keyIndex).toBeGreaterThan(guardIndex);
    });
  }
});

describe('comment surfaces type into the guarded comment field', () => {
  for (const file of [
    'components/chat/message/TextSelectionMenu.tsx',
    'components/chat/composer/ui/ComposerContextChips.tsx',
  ]) {
    test(file, () => {
      const source = readFileSync(join(srcDir, file), 'utf-8');
      expect(source).toContain('<CommentTextEditor');
      expect(source).not.toContain('<textarea');
    });
  }
});
