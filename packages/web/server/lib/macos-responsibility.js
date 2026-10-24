import fs from 'node:fs';
import path from 'node:path';

// macOS attributes privacy decisions, Local Network among them, to the
// responsible process, which for everything the desktop app starts is the app.
// macOS never asks the user about the app, so a terminal or the managed OpenCode
// server started from it cannot reach the local network: `connect()` fails at
// once with EHOSTUNREACH (#4191). The packaged app ships `Resources/disclaim/
// disclaim` (`packages/electron/native/disclaim.c`), which execs the command as
// its own responsible process, so it is judged like one started from launchd.
//
// Anywhere the helper is absent (web, VS Code, desktop development, other
// platforms) the launch is returned unchanged.

const isExecutableFile = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export function resolveResponsibleLaunch(executable, args = [], {
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  isExecutable = isExecutableFile,
} = {}) {
  if (platform !== 'darwin' || !resourcesPath) {
    return { executable, args };
  }
  const helper = path.join(resourcesPath, 'disclaim', 'disclaim');
  if (!isExecutable(helper)) {
    return { executable, args };
  }
  return { executable: helper, args: [executable, ...args] };
}
