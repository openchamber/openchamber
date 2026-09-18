import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isString } from './validation.js';

const execFileAsync = promisify(execFile);

export async function getGlabToken(origin, options = {}) {
  const run = options.execFile ?? execFileAsync;
  const hostname = new URL(origin).host;
  try {
    const result = await run('glab', ['auth', 'token', '--hostname', hostname], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: options.timeoutMs ?? 5_000, windowsHide: true,
    });
    const output = isString(result) ? result : result.stdout;
    const token = isString(output) ? output.trim() : '';
    return token || null;
  } catch {
    return null;
  }
}
