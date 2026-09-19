import { execFile } from 'node:child_process';

// V1 and released V2 both install an `opencode` executable. Probe the resolved
// launch target before allocating ports, credentials, or process ownership.
export const detectOpenCodeCliProtocol = (launch, options = {}) => new Promise((resolve, reject) => {
  execFile(launch.binary, [...launch.args, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4096,
    signal: options.signal,
  }, (error, stdout) => {
    if (error) {
      reject(new Error('Could not determine the OpenCode CLI version', { cause: error }));
      return;
    }
    const version = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(stdout.trim());
    if (!version) {
      reject(new Error('The selected OpenCode CLI does not report a supported V1 or V2 version'));
      return;
    }
    resolve(version[1] === '2' ? 'opencode2' : 'legacy');
  });
});
