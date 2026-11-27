import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { hasErrorCode } from './input-guards.js';
import { guestCopiesDir, readExtensionStore, withGuestCheckoutLock } from './persist.js';

type Checkout = { id: string; packageRoot: string };

const journalSchema = z.object({
  root: z.string().min(1),
  identity: z.string().min(1),
  parked: z.array(z.string().min(1)),
});
type Journal = z.infer<typeof journalSchema>;

const JOURNAL_NAME = /^\.swap-([A-Za-z0-9._-]+)\.json$/;
const DETACHED_NAME = /^\.(?:old|parked)-(.+)$/;

const pathsOf = (copies: string, token: string) => ({
  journal: path.join(copies, `.swap-${token}.json`),
  old: path.join(copies, `.old-${token}`),
  holding: path.join(copies, `.parked-${token}`),
});
type SwapPaths = ReturnType<typeof pathsOf>;

const identityOf = async (target: string) => {
  try {
    const { dev, ino } = await fs.lstat(target, { bigint: true });
    return `${dev}:${ino}`;
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

export const discardDetached = async (directories: string[]) => {
  for (const directory of directories) {
    await fs.rm(directory, { recursive: true, force: true })
      .catch(() => console.warn(`[guests] Could not remove ${path.basename(directory)}`));
  }
};

const readJournal = async (file: string): Promise<Journal | null> => {
  try {
    const parsed = journalSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const settleSwap = async (paths: SwapPaths, { root, identity, parked }: Journal) => {
  let current = await identityOf(root);
  if (current === null && await identityOf(paths.old) !== null) {
    await fs.rename(paths.old, root);
    current = await identityOf(root);
  }
  if (current !== null && current !== identity && await identityOf(paths.old) !== null) {
    await fs.access(path.join(root, 'package.json'));
  }
  if (current === identity) {
    const recreated: string[] = [];
    for (const [index, folder] of parked.entries()) {
      const held = path.join(paths.holding, String(index));
      const original = path.resolve(root, folder);
      if (!original.startsWith(root + path.sep) || await identityOf(held) === null) continue;
      if (recreated.some((parent) => original.startsWith(parent + path.sep))) continue;
      if (await identityOf(original) === null) await fs.rename(held, original);
      else recreated.push(original);
    }
    if (recreated.length > 0) throw new Error('A parked folder was recreated');
  }
  await fs.rm(paths.journal, { force: true });
};

const pendingSwapsIn = (names: string[]) => names.flatMap((name) => JOURNAL_NAME.exec(name)?.[1] ?? []);

const pendingSwaps = async (copies: string) => pendingSwapsIn(await fs.readdir(copies).catch((): string[] => []));

export const detachedCheckouts = async (copies: string) => {
  const names = await fs.readdir(copies).catch((): string[] => []);
  const pending = new Set(pendingSwapsIn(names));
  return names.flatMap((name) => {
    const token = DETACHED_NAME.exec(name)?.[1];
    return token === undefined || pending.has(token) ? [] : [path.join(copies, name)];
  });
};

export const recoverGuestCheckouts = async (persistPath: string) => {
  const copies = guestCopiesDir(persistPath);
  const tokens = await pendingSwaps(copies);
  if (tokens.length === 0) return [];
  const recovered: string[] = [];
  const store = await readExtensionStore(persistPath);
  for (const token of tokens) {
    const paths = pathsOf(copies, token);
    const journal = await readJournal(paths.journal);
    if (!journal) continue;
    try {
      if (store.paths.includes(journal.root)) {
        await settleSwap(paths, journal);
        recovered.push(path.basename(journal.root));
      } else {
        await fs.rm(paths.journal, { force: true });
      }
    } catch {
      console.warn(`[guests] Could not restore the previous checkout in ${path.basename(journal.root)}`);
    }
  }
  void discardDetached(await detachedCheckouts(copies));
  return recovered;
};

export const recoverIdleGuestCheckouts = async (persistPath: string) => {
  if ((await pendingSwaps(guestCopiesDir(persistPath))).length === 0) return [];
  return withGuestCheckoutLock(persistPath, () => recoverGuestCheckouts(persistPath), { waitMs: 0 }).catch((): string[] => []);
};

const writeJournal = async (file: string, journal: Journal) => {
  const temporary = `${file}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(journal), 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

const moveAside = async (from: string, to: string, paths: SwapPaths, journal: Journal): Promise<void> => {
  try {
    await fs.rename(from, to);
  } catch (error) {
    // external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/core/src/plugin/module.ts#L15-L33 retains a watch on the folder of every file a plugin loads.
    if (process.platform !== 'win32' || !hasErrorCode(error)
      || (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY')) throw error;
    const entries = await fs.readdir(from, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(from, entry.name));
    if (folders.length === 0) throw error;
    const first = journal.parked.length;
    journal.parked.push(...folders.map((folder) => path.relative(journal.root, folder)));
    await writeJournal(paths.journal, journal);
    await fs.mkdir(paths.holding, { recursive: true });
    for (const [offset, folder] of folders.entries()) {
      await moveAside(folder, path.join(paths.holding, String(first + offset)), paths, journal);
    }
    await fs.rename(from, to);
  }
};

export const swapGuestCheckout = async (guest: Checkout, copies: string, staged: string) => {
  const root = guest.packageRoot;
  const paths = pathsOf(copies, `${guest.id}-${crypto.randomBytes(6).toString('hex')}`);
  const identity = await identityOf(root);
  if (identity === null) return false;
  const journal: Journal = { root, identity, parked: [] };
  await writeJournal(paths.journal, journal);
  try {
    await moveAside(root, paths.old, paths, journal);
    await fs.rename(staged, root);
  } catch {
    try {
      await settleSwap(paths, journal);
    } catch {
      console.warn(`[guests] Could not restore the previous checkout for ${guest.id}; the next catalog read retries`);
    }
    return false;
  }
  await fs.rm(paths.journal, { force: true })
    .catch(() => console.warn(`[guests] Could not remove the swap record for ${guest.id}`));
  return true;
};
