import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createOverrideStore, resolveOpenCodeDataDir } from './route-overrides-store.js';

const isWindows = process.platform === 'win32';
const FEEDBACK_MAX_BYTES = 4 * 1024 * 1024;

const override = (overrides) => ({
  id: 'interpreter:1:0:avoid',
  action: 'avoid',
  providers: ['anthropic'],
  models: [],
  routes: [],
  fixed: true,
  until: 10_000,
  text: 'stop using anthropic',
  summary: 'avoid: anthropic',
  source: 'interpreter',
  createdAt: 1,
  ...overrides,
});

describe('override store', () => {
  it('writes the file OpenCode reads and keeps the origin of each rule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.add([override({ origin: { key: 'claude', option: 'Anthropic provider only' } })]);
    const written = JSON.parse(fs.readFileSync(store.overridesFile, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.overrides[0]).toMatchObject({ action: 'avoid', providers: ['anthropic'] });
    expect(store.list()[0].origin).toEqual({ key: 'claude', option: 'Anthropic provider only' });
  });

  it('hides and drops overrides past their end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    let clock = 5_000;
    const store = createOverrideStore({ dataDir: dir, now: () => clock });
    store.add([override({ id: 'a', until: 6_000 }), override({ id: 'b', until: 9_000 })]);
    clock = 7_000;
    expect(store.list().map((item) => item.id)).toEqual(['b']);
    store.add([override({ id: 'c', until: 6_500 })]);
    const written = JSON.parse(fs.readFileSync(store.overridesFile, 'utf8'));
    expect(written.overrides.map((item) => item.id)).toEqual(['b']);
  });

  it('removes one rule and says whether it existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.add([override()]);
    expect(store.remove('missing')).toBe(false);
    expect(store.remove('interpreter:1:0:avoid')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('keeps feedback as lines and skips a line it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.recordFeedback({ key: 'claude', option: 'A', accepted: 'corrected' });
    fs.appendFileSync(store.feedbackFile, 'not json\n');
    store.recordFeedback({ key: 'claude', option: 'A', accepted: false });
    expect(store.readFeedback()).toEqual([
      { time: 5_000, key: 'claude', option: 'A', accepted: 'corrected' },
      { time: 5_000, key: 'claude', option: 'A', accepted: false },
    ]);
  });

  it('keeps missing feedback empty without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      expect(store.readFeedback()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns and returns no learned feedback for an over-cap log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      fs.writeFileSync(store.feedbackFile, Buffer.alloc(FEEDBACK_MAX_BYTES + 1, 0x20));

      expect(store.readFeedback()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds the 4194304-byte limit'));
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(isWindows)('warns and refuses a FIFO feedback log without blocking', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      execFileSync('mkfifo', [store.feedbackFile]);

      expect(store.readFeedback()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not a regular file'));
    } finally {
      warn.mockRestore();
    }
  });

  it('enforces the 3 MiB per-entry limit on recorded feedback', () => {
    // Oracle: the 3 MiB per-entry limit documented in packages/web/server/lib/routing/DOCUMENTATION.md.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    const retainBytes = 3 * 1024 * 1024;

    expect(() => {
      store.recordFeedback({ key: 'oversized', note: 'x'.repeat(retainBytes) });
    }).toThrow(RangeError);
    expect(() => {
      store.recordFeedback({ key: 'oversized', note: 'x'.repeat(retainBytes) });
    }).toThrow(`Route feedback entries must fit within ${retainBytes} bytes`);

    const overhead = Buffer.byteLength(JSON.stringify({ time: 5_000, key: 'exact', note: '' }) + '\n');
    store.recordFeedback({ key: 'exact', note: 'x'.repeat(retainBytes - overhead) });

    const feedback = store.readFeedback();
    expect(feedback).toHaveLength(1);
    expect(feedback[0].key).toBe('exact');
  });

  it('keeps the newest complete feedback lines when the log reaches its cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      const oldest = `${JSON.stringify({ time: 1, key: 'oldest', note: 'x'.repeat(1024) })}\n`;
      const prior = `${JSON.stringify({ time: 2, key: 'prior', note: 'y'.repeat(1024) })}\n`;
      const copies = Math.ceil((FEEDBACK_MAX_BYTES + 1 - Buffer.byteLength(oldest)) / Buffer.byteLength(prior));
      fs.writeFileSync(store.feedbackFile, oldest + prior.repeat(copies));
      if (!isWindows) fs.chmodSync(store.feedbackFile, 0o640);

      store.recordFeedback({ key: 'newest', option: 'A', accepted: false });

      expect(fs.statSync(store.feedbackFile).size).toBeLessThanOrEqual(FEEDBACK_MAX_BYTES);
      if (!isWindows) expect(fs.statSync(store.feedbackFile).mode & 0o777).toBe(0o640);
      const feedback = store.readFeedback();
      expect(feedback.at(-1)).toMatchObject({ key: 'newest', accepted: false });
      expect(feedback.some((entry) => entry.key === 'oldest')).toBe(false);
      expect(feedback.some((entry) => entry.key === 'prior')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves an append that lands during compaction from a second writer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      const oldest = `${JSON.stringify({ time: 1, key: 'oldest', note: 'x'.repeat(1024) })}\n`;
      const prior = `${JSON.stringify({ time: 2, key: 'prior', note: 'y'.repeat(1024) })}\n`;
      const copies = Math.ceil((FEEDBACK_MAX_BYTES + 1 - Buffer.byteLength(oldest)) / Buffer.byteLength(prior));
      fs.writeFileSync(store.feedbackFile, oldest + prior.repeat(copies));

      let appended = false;
      const originalWriteFileSync = fs.writeFileSync;
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        originalWriteFileSync(file, data, options);
        if (String(file).includes('.tmp') && !appended) {
          appended = true;
          // Simulate second writer appending to feedbackFile before rename
          fs.appendFileSync(
            store.feedbackFile,
            `${JSON.stringify({ time: 5_000, key: 'concurrent', option: 'B', accepted: true })}\n`,
          );
        }
      });

      try {
        store.recordFeedback({ key: 'newest', option: 'A', accepted: false });
      } finally {
        writeSpy.mockRestore();
      }

      const feedback = store.readFeedback();
      expect(feedback.some((entry) => entry.key === 'concurrent')).toBe(true);
      expect(feedback.some((entry) => entry.key === 'newest')).toBe(true);
      expect(feedback.at(-1)).toMatchObject({ key: 'concurrent', accepted: true });
      expect(feedback.at(-2)).toMatchObject({ key: 'newest', accepted: false });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not overwrite a file that was concurrently compacted by another process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      const oldest = `${JSON.stringify({ time: 1, key: 'oldest', note: 'x'.repeat(1024) })}\n`;
      const prior = `${JSON.stringify({ time: 2, key: 'prior', note: 'y'.repeat(1024) })}\n`;
      const copies = Math.ceil((FEEDBACK_MAX_BYTES + 1 - Buffer.byteLength(oldest)) / Buffer.byteLength(prior));
      fs.writeFileSync(store.feedbackFile, oldest + prior.repeat(copies));

      let compacted = false;
      const originalWriteFileSync = fs.writeFileSync;
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        originalWriteFileSync(file, data, options);
        if (String(file).includes('.tmp') && !compacted) {
          compacted = true;
          // Simulate another process compacting the file first to a small size
          fs.writeFileSync(
            store.feedbackFile,
            `${JSON.stringify({ time: 4_500, key: 'compacted-by-other', option: 'C', accepted: true })}\n`,
          );
        }
      });

      try {
        store.recordFeedback({ key: 'newest', option: 'A', accepted: false });
      } finally {
        writeSpy.mockRestore();
      }

      const feedback = store.readFeedback();
      expect(feedback.some((entry) => entry.key === 'compacted-by-other')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves a corrupt overrides file instead of silently discarding every rule', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      const corrupt = '{"version":1,"overrides":[{"id":"a","action":"avoid"';
      fs.writeFileSync(store.overridesFile, corrupt);
      expect(store.list()).toEqual([]);
      const preservedName = fs.readdirSync(dir).find((name) => name.startsWith('route-overrides.json.corrupt-'));
      expect(preservedName).toBeTruthy();
      const preservedFile = path.join(dir, preservedName);
      expect(fs.readFileSync(preservedFile, 'utf8')).toBe(corrupt);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(preservedFile));
      // No warning may quote the corrupt file's content: JSON.parse errors
      // embed an excerpt, and override text is the user's own sentence.
      const warned = warn.mock.calls.flat().map(String).join(' ');
      expect(warned).not.toContain('avoid');
      // A later save lands in the real file; the corrupt bytes stay preserved.
      store.add([override({ id: 'fresh' })]);
      expect(store.list().map((item) => item.id)).toEqual(['fresh']);
      expect(fs.readFileSync(preservedFile, 'utf8')).toBe(corrupt);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to overwrite an existing overrides file it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    // A directory at the store path makes the guard's read fail with EISDIR:
    // an existing file whose bytes can be neither parsed nor preserved, so
    // the save must refuse rather than rename a new file over it.
    fs.mkdirSync(store.overridesFile);
    expect(() => store.add([override({ id: 'fresh' })])).toThrow(
      /Refusing to overwrite the unreadable route overrides file/,
    );
    expect(fs.statSync(store.overridesFile).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves no temp file behind after a save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.add([override()]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a missing overrides file as empty and preserves nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('places the data under XDG_DATA_HOME', () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: '/x/data' })).toBe(path.join('/x/data', 'opencode'));
  });
});
