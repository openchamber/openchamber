
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

export const openCodeProjectStartCommandSource = ({
  buildOpenCodeUrl, getOpenCodeAuthHeaders,
}: ProjectStartCommandConnection): ProjectStartCommandSource => ({
  read: async (directory) => {
    const client = OpenCode.make({
      baseUrl: buildOpenCodeUrl('', '').replace(/\/+$/, ''),
      headers: { ...getOpenCodeAuthHeaders(), 'x-opencode-directory': encodeURIComponent(directory) },
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
