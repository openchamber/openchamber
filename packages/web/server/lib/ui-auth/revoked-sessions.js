import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const revokedSessionsSchema = z.object({
  version: z.literal(1),
  revoked: z.array(z.object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().finite(),
  })),
});

const digestOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const createRevokedSessions = (file) => {
  let entries = [];
  let loadFailed = false;
  try {
    const saved = revokedSessionsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    entries = saved.revoked.filter((entry) => entry.expiresAt > Date.now());
  } catch (error) {
    if (error.code !== 'ENOENT') {
      loadFailed = true;
    }
  }
  let quarantineNeeded = loadFailed;
  const quarantine = () => {
    if (!quarantineNeeded) return;
    quarantineNeeded = false;
    try {
      fs.renameSync(file, `${file}.unreadable-${new Date().toISOString()}`);
    } catch {
      // Clearing must still proceed after key rotation when quarantine fails.
    }
  };
  let digests = new Set(entries.map((entry) => entry.digest));
  let pending = Promise.resolve();

  // Queue the entire read/modify/write operation, including global sign-out.
  const update = (change, mergeDisk = true) => {
    const operation = pending.then(async () => {
      let saved = [];
      if (mergeDisk) {
        try {
          saved = revokedSessionsSchema.parse(JSON.parse(await fs.promises.readFile(file, 'utf8'))).revoked;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const live = [...entries, ...saved].filter((entry) => entry.expiresAt > Date.now());
      const current = [...new Map(live.map((entry) => [entry.digest, entry])).values()];
      const next = change(current).filter((entry) => entry.expiresAt > Date.now());
      const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const handle = await fs.promises.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ version: 1, revoked: next }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(temporary, file);
        const directory = await fs.promises.open(path.dirname(file), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        entries = next;
        digests = new Set(next.map((entry) => entry.digest));
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
    });
    pending = operation.catch(() => {}); // A failed write must not block the next attempt.
    return operation;
  };

  return {
    loadFailed,
    quarantine,
    has: (token) => digests.has(digestOf(token)),
    revoke: (token, expiresAt) => update((current) => {
      const digest = digestOf(token);
      return current.some((entry) => entry.digest === digest) ? current : [...current, { digest, expiresAt }];
    }),
    // A rotated key invalidates all old digests, including unreadable disk state.
    clear: () => {
      quarantine();
      return update(() => [], false);
    },
  };
};
