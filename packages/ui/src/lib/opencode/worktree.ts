/**
 * OpenCode's `worktree.directory` setting, read and written the way Settings
 * shows it.
 *
 * OpenCode owns the key, so the values come from the runtime that owns the
 * repository rather than from a config file the UI reads itself:
 * - `GET /api/config/worktree` reports the effective value, the config file it
 *   came from, and the file a Settings write would land in. OpenCode resolves a
 *   relative path against the project's primary checkout, so the value is stored
 *   as written and resolved where the repository lives.
 * - `PUT /api/config/worktree` writes that file and clears the key when the value
 *   is `null`.
 *
 * A read that fails throws. An unreadable destination is not the same as an
 * unset one, and the git service treats the difference as an error.
 */

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const configBodySchema = z.object({
  directory: z.string().nullable(),
  source: z.enum(['custom', 'project', 'global']).nullable(),
  path: z.string().nullable(),
  writePath: z.string().nullable(),
  locked: z.boolean(),
});

/** Where the effective `worktree.directory` came from and where a write would go. */
export interface WorktreeDirectoryConfig {
  /** The configured folder as written, or `null` when OpenCode has none. */
  directory: string | null;
  /** Which config layer wins; `null` when nothing sets the key. */
  source: 'custom' | 'project' | 'global' | null;
  /** The file the value came from, or `null` when nothing sets the key. */
  path: string | null;
  /** The file a Settings write lands in. */
  writePath: string | null;
  /** A config file Settings cannot write wins, so a write would not take effect. */
  locked: boolean;
}

const readErrorMessage = async (response: Response): Promise<string> => {
  const body = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
  return body.data?.error ?? `HTTP ${response.status}`;
};

/** The effective `worktree.directory` for a project, with the file behind it. */
export async function readWorktreeDirectory(directory: string | null): Promise<WorktreeDirectoryConfig> {
  const response = await runtimeFetch('/api/config/worktree', {
    headers: { Accept: 'application/json' },
    query: directory ? { directory } : undefined,
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return configBodySchema.parse(await response.json());
}

/** Writes the folder, or clears the key when `value` is `null`. */
export async function saveWorktreeDirectory(
  directory: string | null,
  projectDirectory: string | null,
): Promise<{ changed: boolean; path: string | null }> {
  const response = await runtimeFetch('/api/config/worktree', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    query: projectDirectory ? { directory: projectDirectory } : undefined,
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return z
    .object({ changed: z.boolean(), path: z.string().nullable() })
    .parse(await response.json());
}
