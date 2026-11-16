
import { OpenCode } from '@opencode/client';

let source = null;

export function configureProjectStartCommandSource(next) {
  source = next ?? null;
}

export const openCodeProjectStartCommandSource = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => ({
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

export const readProjectStartCommand = async (directory) => {
  if (!source) return '';
  try {
    return await source.read(directory);
  } catch (error) {
    console.warn('Failed to read the project start command from OpenCode:', error instanceof Error ? error.message : String(error));
    return '';
  }
};
