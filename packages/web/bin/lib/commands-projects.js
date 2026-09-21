import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestControlAction } from './cli-control.js';
import { isJsonMode, printJson } from '../cli-output.js';

const formatProjectLine = (project) => `- \`${project.label}\` — \`${project.id}\` — \`${project.path}\``;

async function projectsCommand(options = {}, action = 'list') {
  if (action === 'help') {
    process.stdout.write(`OpenChamber Projects Commands\n\nUSAGE:\n  openchamber projects [OPTIONS]\n\nOUTPUT OPTIONS:\n  -p, --port <port>       OpenChamber server port\n  --json                  Output machine-readable JSON\n`);
    return;
  }
  if (action !== 'list') {
    throw new TunnelCliError(`Unknown projects command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const port = await resolveTargetPort(options);
  const { projects = [] } = await requestControlAction(port, 'projects.list', {}, options);
  if (isJsonMode(options)) {
    printJson({ projects });
    return;
  }
  process.stdout.write(projects.length > 0
    ? `${projects.map(formatProjectLine).join('\n')}\n`
    : 'No projects found.\n');
}

export { projectsCommand, formatProjectLine };
