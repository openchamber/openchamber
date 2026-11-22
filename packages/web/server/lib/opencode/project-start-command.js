/**
 * The project's start command (`commands.start`): what OpenCode runs in every
 * new worktree of a project, such as a dependency install. Shared by the web
 * server and the VS Code extension host, which create worktrees themselves and
 * so run it themselves.
 *
 * OpenCode 2.x keeps the command on its project record, in its database, and
 * hands it out through the API only. The project ID comes from OpenCode too:
 * 2.x derives it from the origin remote, while OpenChamber's own worktree ID is
 * the root commit, so the two differ for most repositories. `GET /api/location`
 * names the project a checkout belongs to and `GET /api/project` holds its
 * record. Both reads are scoped to the directory the worktree is requested
 * from, which the user already works in, so they start no new location.
 *
 * A failed read runs no command and logs why, the same outcome as a failing
 * command: the worktree itself is still created.
 */

import { OpenCode } from '@opencode/client';

// Wired once per runtime: `server/index.js` on the web server, the extension
// entry point in VS Code. Until then no command runs.
let source = null;

/** Wires the reader to a source (`{ read(directory) }`). Pass `null` to detach. */
export function configureProjectStartCommandSource(next) {
  source = next ?? null;
}

/**
 * The running OpenCode as the source. The URL and auth headers are read on
 * every call because the port and the server password both move across an
 * OpenCode restart.
 */
// Deadline for one read from OpenCode. The SDK composes no default
// deadline, so without a signal a stalled OpenCode never rejects: the
// failed-read fallback below never runs and worktree bootstrap wedges
// ahead of the start command it was trying to read. These are loopback
// calls that answer in well under a second on a healthy instance; 8
// seconds (the deadline skill-routes.js uses for the same kind of read)
// only ever fires on a genuine stall, and the catch in
// readProjectStartCommand takes it from there.
const PROJECT_START_COMMAND_READ_TIMEOUT_MS = 8_000;

export const openCodeProjectStartCommandSource = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => ({
  read: async (directory) => {
    const client = OpenCode.make({
      baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
      headers: { ...getOpenCodeAuthHeaders(), 'x-opencode-directory': encodeURIComponent(directory) },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(PROJECT_START_COMMAND_READ_TIMEOUT_MS) }),
    });
    const [location, projects] = await Promise.all([client.location.get(), client.project.list()]);
    const project = projects.find((entry) => entry.id === location.project.id);
    return project?.commands?.start?.trim() ?? '';
  },
});

/** The start command of the project `directory` belongs to, or '' when there is none or it cannot be read. */
export const readProjectStartCommand = async (directory) => {
  if (!source) return '';
  try {
    return await source.read(directory);
  } catch (error) {
    console.warn('Failed to read the project start command from OpenCode:', error instanceof Error ? error.message : String(error));
    return '';
  }
};
