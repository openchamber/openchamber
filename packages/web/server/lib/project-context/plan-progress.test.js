import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPlanSummaryCache, parsePlanProgress, readBoundedUtf8, PLAN_FILE_READ_MAX_BYTES, PLAN_SUMMARY_CACHE_MAX_ENTRIES } from './plan-progress.js';

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

      await fsPromises.writeFile(file, `# Big\n${'x'.repeat(PLAN_FILE_READ_MAX_BYTES)}`);
      const readsBefore = reads;
      const big = await cache.summaryOf(file);
      expect(big.tooLarge).toBe(true);
      expect(big.progress).toBeNull();
      expect(reads).toBe(readsBefore);
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  test('bounds the cache: entries past the cap evict least recently used first', async () => {
    // In-memory fs: stat/readFile over a Map, counting reads per path, so the
    // test can plant more distinct plans than the cap without real files.
    // No `open`, so the bounded read falls back to readFile.
    const files = new Map();
    const reads = new Map();
    const addPlan = (name) => {
      const content = `# ${name}\n\n## Steps\n- [ ] one\n`;
      files.set(`/plans/${name}.md`, { mtimeMs: 1, size: content.length, content });
    };
    const fake = {
      stat: async (filePath) => {
        const file = files.get(filePath);
        if (!file) {
          const error = new Error('gone');
          error.code = 'ENOENT';
          throw error;
        }
        return { mtimeMs: file.mtimeMs, size: file.size };
      },
      readFile: async (filePath) => {
        reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
        return files.get(filePath).content;
      },
    };
    const cache = createPlanSummaryCache({ fsPromises: fake, parseTitle: () => 'Plan' });
    const planPath = (index) => `/plans/plan-${index}.md`;

    for (let index = 0; index < PLAN_SUMMARY_CACHE_MAX_ENTRIES; index += 1) addPlan(`plan-${index}`);
    for (let index = 0; index < PLAN_SUMMARY_CACHE_MAX_ENTRIES; index += 1) {
      await cache.summaryOf(planPath(index));
    }
    // Re-listing the first plan is a hit (no second read) and refreshes it.
    await cache.summaryOf(planPath(0));
    expect(reads.get(planPath(0))).toBe(1);

    // Twenty-five new plans push the cache past its cap.
    for (let index = 0; index < 25; index += 1) {
      const extra = PLAN_SUMMARY_CACHE_MAX_ENTRIES + index;
      addPlan(`plan-${extra}`);
      await cache.summaryOf(planPath(extra));
    }

    // The refreshed live entry survived; the oldest untouched entries were
    // evicted, so re-listing one costs a read again; a recent entry still hits.
    await cache.summaryOf(planPath(0));
    expect(reads.get(planPath(0))).toBe(1);
    await cache.summaryOf(planPath(1));
    expect(reads.get(planPath(1))).toBe(2);
    const newest = planPath(PLAN_SUMMARY_CACHE_MAX_ENTRIES + 24);
    await cache.summaryOf(newest);
    expect(reads.get(newest)).toBe(1);
  });

  test('a file that grows past the cap after its stat degrades to tooLarge without a whole read', async () => {
    // stat reports a small file, but the open handle yields cap+1 bytes:
    // the bounded read must stop at the cap and mark the plan tooLarge.
    const fake = {
      stat: async () => ({ mtimeMs: 1, size: 10 }),
      readFile: async () => { throw new Error('readFile must not be used when open exists'); },
      open: async () => ({
        read: async (buffer, offset, length) => {
          buffer.fill(120, offset, offset + length);
          return { bytesRead: length };
        },
        close: async () => {},
      }),
    };
    const cache = createPlanSummaryCache({ fsPromises: fake, parseTitle: () => 'Plan' });
    const summary = await cache.summaryOf('/plans/growing.md');
    expect(summary.tooLarge).toBe(true);
    expect(summary.progress).toBeNull();
    expect(await readBoundedUtf8(fake, '/plans/growing.md', 8)).toBeNull();
  });
});

describe('readBoundedUtf8 non-regular files', () => {
  test.skipIf(process.platform === 'win32')('a FIFO at a plan path is refused promptly instead of blocking at open', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-plan-fifo-'));
    try {
      const file = path.join(dir, 'plan.md');
      execFileSync('mkfifo', [file]);
      await expect(readBoundedUtf8(fsPromises, file, 1024)).rejects.toThrow('not a regular file');
      const cache = createPlanSummaryCache({ fsPromises, parseTitle: () => 'Plan' });
      await expect(cache.summaryOf(file)).rejects.toThrow('not a regular file');
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});
