
import { OpenCode } from '@opencode/client';

export type ProjectStartCommandSource = {
  read: (directory: string) => Promise<string>;
};

export interface ProjectStartCommandConnection {
  buildOpenCodeUrl: (path: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
}

let source: ProjectStartCommandSource | null = null;

export function configureProjectStartCommandSource(next: ProjectStartCommandSource | null) {
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

export const openCodeProjectStartCommandSource = ({
  buildOpenCodeUrl, getOpenCodeAuthHeaders,
}: ProjectStartCommandConnection): ProjectStartCommandSource => ({
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

export const readProjectStartCommand = async (directory: string) => {
  if (!source) return '';
  try {
    return await source.read(directory);
  } catch (error) {
    console.warn('Failed to read the project start command from OpenCode:', error instanceof Error ? error.message : String(error));
    return '';
  }
};
