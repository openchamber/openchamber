/**
 * Shared with packages/web/server/lib/opencode/worktree-directory.js via esbuild
 * bundling. Keep this module a thin re-export so the web server and the
 * extension host resolve OpenCode's `worktree.directory` to the same folder.
 *
 * Known limitation, pre-existing to the worktree setting: the web reader in
 * `packages/web/server/lib/opencode/shared.js` merges a secondary user config
 * file (`opencode.jsonc` beside `opencode.json`) as an override layer, while the
 * extension host's reader in `opencodeConfig.ts` reads only the primary user
 * file. A `worktree.directory` set only in the secondary user file is therefore
 * honored by web/desktop and ignored by the extension host. Making the two
 * readers agree is a separate change to how the extension reads every config
 * surface.
 */
export * from '../../web/server/lib/opencode/worktree-directory.js';
