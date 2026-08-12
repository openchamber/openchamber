import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./MessageBody.tsx', import.meta.url), 'utf8');

describe('completed answer actions', () => {
  test('accepts a completion timestamp or explicit stop for the full-context fork action', () => {
    expect(source).toContain('const isCompletedAnswer = isMessageCompleted || hasStopFinish;');
    expect(source).toContain(
      'const shouldShowTurnFooter = isLastAssistantInTurn && hasTextContent && (isCompletedAnswer || Boolean(errorMessage));',
    );
    expect(
      /turnGroupingContext\?\.isLatestTurn === true\s+&& isLastAssistantInTurn\s+&& isCompletedAnswer\s+&& sessionId/.test(source),
    ).toBe(true);
  });
});
