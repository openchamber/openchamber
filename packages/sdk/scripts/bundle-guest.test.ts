import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./bundle-guest.ts', import.meta.url));
const guestEntry = path.resolve(
  fileURLToPath(new URL('./fixtures/guest-entry.ts', import.meta.url)),
);

describe('bundle-guest', () => {
  test('builds a guest entry to a classic IIFE', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-guest-bundle-'));
    const outfile = path.join(dir, 'main.js');
    try {
      const proc = Bun.spawn(['bun', script, guestEntry, outfile], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exit = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(exit).toBe(0);
      expect(stderr).toBe('');
      const text = await readFile(outfile, 'utf8');
      expect(text).toContain('openchamber.sdk');
      expect(text).toContain('HELLO-1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('--node keeps ESM for a local service entry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-guest-bundle-'));
    const outfile = path.join(dir, 'service.js');
    try {
      const proc = Bun.spawn(['bun', script, '--node', guestEntry, outfile], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exit = await proc.exited;
      expect(exit).toBe(0);
      const text = await readFile(outfile, 'utf8');
      expect(text).toContain('openchamber.sdk');
      expect(text).not.toMatch(/^\(\(\) => \{/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
