import { describe, expect, it } from 'vitest';
import { buildPrompt } from './prompt.js';

const input = {
  digest: { files: [] },
  fileCount: 1,
  hunkCount: 1,
  source: { kind: 'working-tree', scope: 'all' },
};

const promptFor = (previousWalkthrough) => buildPrompt({ ...input, previousWalkthrough }).prompt;

describe('previous walkthrough JSON', () => {
  it('omits missing, non-array and empty chapters', () => {
    for (const previous of [undefined, null, false, 0, '', [], {}, { chapters: null }, { chapters: {} }, { chapters: [] }]) {
      expect(promptFor(previous)).toBe(promptFor(undefined));
    }
  });

  it('retains primitive chapter and stop property reads and JSON text coercion', () => {
    expect(promptFor({ chapters: [4, 'a', false, []] }))
      .toContain('Previous walkthrough — "undefined":\n- undefined\n\n- undefined\n\n- undefined\n\n- undefined\n');
    expect(promptFor({
      title: ['old', 'title'],
      chapters: [{ title: ['a', 'b'], blurb: { x: 1 }, stops: [4, 's', false, []] }],
    })).toContain('Previous walkthrough — "old,title":\n- a,b — [object Object]\n'
      + '  - undefined: undefined\n  - undefined: undefined\n  - undefined: undefined\n  - undefined: undefined');
  });

  it('treats falsy stops as empty', () => {
    for (const stops of [undefined, null, false, 0, '']) {
      expect(promptFor({ chapters: [{ title: 'Chapter', stops }] }))
        .toContain('- Chapter\n');
    }
  });

  it('keeps malformed-cache TypeErrors instead of dropping bad chapters or stops', () => {
    for (const [previous, message] of [
      [{ chapters: [null] }, "Cannot read properties of null (reading 'stops')"],
      [{ chapters: [{ stops: [null] }] }, "Cannot read properties of null (reading 'title')"],
      [{ chapters: [{ stops: 'bad' }] }, '(chapter.stops || []).map is not a function'],
      [{ chapters: [{ stops: {} }] }, '(chapter.stops || []).map is not a function'],
    ]) {
      expect(() => promptFor(previous)).toThrow(new TypeError(message));
    }
  });
});
