import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const editorSource = readFileSync(join(__dirname, 'CommentTextEditor.tsx'), 'utf-8');

describe('CommentTextEditor IME handling', () => {
  test('ignores composition keydown events before handling save shortcuts', () => {
    expect(editorSource).toContain("import { isIMECompositionEvent } from '@/lib/ime';");

    const handlerStart = editorSource.indexOf('const handleKeyDown');
    const handlerEnd = editorSource.indexOf('const handlePaste', handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const handler = editorSource.slice(handlerStart, handlerEnd);
    const imeGuard = handler.indexOf('if (isIMECompositionEvent(event)) return false;');
    const saveShortcut = handler.indexOf("event.key === 'Enter'");
    expect(imeGuard).toBeGreaterThan(-1);
    expect(saveShortcut).toBeGreaterThan(imeGuard);
  });
});
