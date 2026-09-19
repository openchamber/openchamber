import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const inputSource = readFileSync(join(__dirname, 'InlineCommentInput.tsx'), 'utf-8');

describe('InlineCommentInput IME handling', () => {
  test('ignores composition keydown events before handling save shortcuts', () => {
    expect(inputSource).toContain("import { isIMECompositionEvent } from '@/lib/ime';");

    const handlerStart = inputSource.indexOf('const handleKeyDown');
    const handlerEnd = inputSource.indexOf('const handleSaveClick', handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const handler = inputSource.slice(handlerStart, handlerEnd);
    const imeGuard = handler.indexOf('if (isIMECompositionEvent(e)) return;');
    const saveShortcut = handler.indexOf("e.key === 'Enter'");
    expect(imeGuard).toBeGreaterThan(-1);
    expect(saveShortcut).toBeGreaterThan(imeGuard);
  });
});
