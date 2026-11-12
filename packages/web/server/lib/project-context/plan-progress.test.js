import { describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPlanSummaryCache, parsePlanProgress } from './plan-progress.js';

describe('parsePlanProgress', () => {
  test('counts the ticked and open steps of the ## Steps checklist', () => {
    expect(parsePlanProgress('# Plan\n\n## Steps\n- [x] one\n- [X] two\n- [ ] three\n')).toEqual({ done: 2, total: 3 });
  });

  test('stops at the next section, so later checklists are not progress', () => {
    const raw = '# Plan\n\n## Steps\n- [x] one\n- [ ] two\n\n## Testing\n- [ ] unit\n- [ ] manual\n';
    expect(parsePlanProgress(raw)).toEqual({ done: 1, total: 2 });
  });

  test('keeps nested headings inside the section', () => {
    const raw = '## Steps\n- [x] one\n### Notes on one\ntext\n- [ ] two\n';
    expect(parsePlanProgress(raw)).toEqual({ done: 1, total: 2 });
  });

  test('a plan without the section or without items has no progress', () => {
    expect(parsePlanProgress('# Plan\n\n- [x] loose item\n')).toBeNull();
    expect(parsePlanProgress('# Plan\n\n## Steps\n\nWrite them later.\n')).toBeNull();
    expect(parsePlanProgress('')).toBeNull();
  });

  test('reads CRLF files and other list markers', () => {
    expect(parsePlanProgress('## steps\r\n* [x] one\r\n+ [ ] two\r\n')).toEqual({ done: 1, total: 2 });
  });
});

describe('createPlanSummaryCache', () => {
  test('re-reads a file only after it changed, and forgets one that is gone', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-plan-progress-'));
    try {
      const file = path.join(dir, 'plan.md');
      await fsPromises.writeFile(file, '# Plan\n\n## Steps\n- [ ] one\n- [ ] two\n');
      let reads = 0;
      const counting = { stat: fsPromises.stat, readFile: (...args) => { reads += 1; return fsPromises.readFile(...args); } };
      const cache = createPlanSummaryCache({ fsPromises: counting, parseTitle: () => 'Plan' });

      expect((await cache.summaryOf(file)).progress).toEqual({ done: 0, total: 2 });
      await cache.summaryOf(file);
      expect(reads).toBe(1);

      await fsPromises.writeFile(file, '# Plan\n\n## Steps\n- [x] one\n- [ ] two\n- [ ] three\n');
      expect((await cache.summaryOf(file)).progress).toEqual({ done: 1, total: 3 });
      expect(reads).toBe(2);

      await fsPromises.rm(file);
      expect(await cache.summaryOf(file)).toBeNull();
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});
