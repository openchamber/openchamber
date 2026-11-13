import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

// Windows "Open in" discovery runs in the Electron main process, so every
// child-process wait here must be async: a spawnSync per candidate app froze
// the window for the whole scan (about 36 where.exe runs plus PowerShell).

const execFileAsync = promisify(execFile);

// A lookup that never exits would hold the shared scan open until restart and
// leave the "Open in" list empty; a timed-out lookup counts as not found.
const WHERE_TIMEOUT_MS = 10_000;
const POWERSHELL_TIMEOUT_MS = 15_000;

const WINDOWS_CLI_BY_APP_ID = {
  vscode: 'code.cmd',
  cursor: 'cursor.cmd',
  vscodium: 'codium.cmd',
  windsurf: 'windsurf.cmd',
  zed: 'zed.cmd',
};

const WINDOWS_APP_EXECUTABLES = {
  terminal: ['wt.exe', 'WindowsTerminal.exe'],
  vscode: ['code.exe', 'code.cmd'],
  cursor: ['cursor.exe', 'cursor.cmd'],
  vscodium: ['codium.exe', 'codium.cmd'],
  windsurf: ['windsurf.exe', 'windsurf.cmd'],
  zed: ['zed.exe', 'zed.cmd'],
  'visual-studio': ['devenv.exe'],
  'sublime-text': ['subl.exe', 'sublime_text.exe'],
};

const WINDOWS_APP_ID_BY_NAME = new Map([
  ['finder', 'finder'],
  ['file explorer', 'finder'],
  ['terminal', 'terminal'],
  ['windows terminal', 'terminal'],
  ['visual studio code', 'vscode'],
  ['cursor', 'cursor'],
  ['vscodium', 'vscodium'],
  ['windsurf', 'windsurf'],
  ['zed', 'zed'],
  ['visual studio', 'visual-studio'],
  ['sublime text', 'sublime-text'],
]);

const getWindowsAppIdForName = (appName) => WINDOWS_APP_ID_BY_NAME.get(String(appName || '').trim().toLowerCase()) || '';

const firstLine = (stdout) => String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;

const resolveWindowsScriptIconExecutable = (scriptPath) => {
  if (!scriptPath || !/\.(?:cmd|bat)$/i.test(scriptPath)) return null;
  let source = '';
  try {
    source = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return null;
  }
  const scriptDir = path.dirname(scriptPath);
  const matches = [...source.matchAll(/(?:(?:%~dp0|%~dp0\\|%~dp0\/|\.\.\\|\.\.\/|[A-Za-z]:\\|[A-Za-z]:\/)[^"'\r\n]*?\.exe)/gi)];
  for (const match of matches) {
    const raw = String(match[0] || '').replace(/^%~dp0[\\/]?/i, '').trim();
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(scriptDir, raw);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const imageFileToDataUrl = (filePath) => {
  if (!filePath) return null;
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    return null;
  }
};

// `run` is execFile's promise form and `getFileIcon` is Electron's
// app.getFileIcon; tests pass their own.
export const createWindowsAppDiscovery = ({ run = execFileAsync, getFileIcon, env = process.env }) => {
  const runWhere = async (program) => {
    try {
      const { stdout } = await run('where.exe', [program], { encoding: 'utf8', windowsHide: true, timeout: WHERE_TIMEOUT_MS });
      return firstLine(stdout);
    } catch {
      return null;
    }
  };

  const findWindowsExecutable = async (appId) => {
    for (const program of WINDOWS_APP_EXECUTABLES[appId] || []) {
      const resolved = await runWhere(program);
      if (resolved) return resolved;
    }
    return null;
  };

  const findWindowsAppNameExecutable = async (appName) => {
    const program = `${String(appName || '').trim()}.exe`.replace(/\s+/g, '');
    return program === '.exe' ? null : runWhere(program);
  };

  const readWindowsTerminalPackagePath = async () => {
    const powershell = await runWhere('powershell.exe') || await runWhere('pwsh.exe');
    if (powershell) {
      const command = '$packages = @(' +
        'Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue;' +
        'Get-AppxPackage -Name Microsoft.WindowsTerminalPreview -ErrorAction SilentlyContinue' +
        ') | Where-Object { $_.InstallLocation } | Sort-Object Version -Descending; ' +
        'if ($packages) { $packages[0].InstallLocation }';
      try {
        const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: POWERSHELL_TIMEOUT_MS,
        });
        const packagePath = firstLine(stdout);
        if (packagePath && fs.existsSync(packagePath)) return packagePath;
      } catch {
      }
    }

    const programFilesRoots = [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files']
      .filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
    for (const root of programFilesRoots) {
      const windowsAppsPath = path.join(root, 'WindowsApps');
      let entries = [];
      try {
        entries = fs.readdirSync(windowsAppsPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const packageNames = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => /^Microsoft\.WindowsTerminal(?:Preview)?_.*__8wekyb3d8bbwe$/i.test(name))
        .sort()
        .reverse();
      const stable = packageNames.find((name) => /^Microsoft\.WindowsTerminal_/i.test(name));
      const selected = stable || packageNames[0];
      if (selected) return path.join(windowsAppsPath, selected);
    }
    return null;
  };

  // One lookup per app run. Holding the promise lets a scan that starts while
  // another is still waiting on PowerShell share its answer.
  let windowsTerminalPackagePath;
  const resolveWindowsTerminalPackagePath = () => {
    windowsTerminalPackagePath ??= readWindowsTerminalPackagePath();
    return windowsTerminalPackagePath;
  };

  const resolveWindowsTerminalIconPath = async () => {
    const packagePath = await resolveWindowsTerminalPackagePath();
    if (!packagePath) return null;
    const candidates = [
      path.join(packagePath, 'Images', 'Square44x44Logo.targetsize-96_altform-unplated.png'),
      path.join(packagePath, 'Images', 'Square44x44Logo.targetsize-96.png'),
      path.join(packagePath, 'Images', 'StoreLogo.scale-200.png'),
      path.join(packagePath, 'Images', 'StoreLogo.scale-100.png'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  };

  const resolveWindowsTerminalExecutable = async () => {
    const packagePath = await resolveWindowsTerminalPackagePath();
    if (packagePath) {
      const executable = path.join(packagePath, 'WindowsTerminal.exe');
      if (fs.existsSync(executable)) return executable;
    }
    return findWindowsExecutable('terminal');
  };

  const resolveWindowsAppIconExecutable = async ({ appId, appName }) => {
    if (appId === 'finder') {
      const explorerPath = path.join(env.SystemRoot || 'C:\\Windows', 'explorer.exe');
      return fs.existsSync(explorerPath) ? explorerPath : 'explorer.exe';
    }
    if (appId === 'terminal') {
      return resolveWindowsTerminalExecutable();
    }

    const executable = await findWindowsExecutable(appId) || await findWindowsAppNameExecutable(appName);
    if (!executable) return null;
    if (/\.exe$/i.test(executable)) return executable;
    return resolveWindowsScriptIconExecutable(executable) || executable;
  };

  const windowsIconToDataUrl = async (executablePath) => {
    if (!executablePath) return null;
    try {
      const image = await getFileIcon(executablePath, { size: 'normal' });
      if (image.isEmpty()) return null;
      return image.toDataURL();
    } catch {
      return null;
    }
  };

  const resolveWindowsAppIcon = async (appName) => {
    const appId = getWindowsAppIdForName(appName);
    if (appId === 'terminal') {
      const packagedIcon = imageFileToDataUrl(await resolveWindowsTerminalIconPath());
      if (packagedIcon) return packagedIcon;
    }
    return windowsIconToDataUrl(await resolveWindowsAppIconExecutable({ appId, appName }));
  };

  const isWindowsAppInstalled = async ({ appId, appName }) => {
    if (appId === 'finder') return true;
    if (appId === 'terminal') return Boolean(await findWindowsExecutable('terminal'));
    if (await findWindowsExecutable(appId)) return true;
    return Boolean(await findWindowsAppNameExecutable(appName));
  };

  const buildWindowsInstalledApps = async (apps) => {
    const seen = new Set();
    const candidates = (Array.isArray(apps) ? apps : [])
      .map((appName) => String(appName || '').trim())
      .filter((appName) => appName && !seen.has(appName) && seen.add(appName));
    const results = [];
    for (const name of candidates) {
      if (!(await isWindowsAppInstalled({ appId: getWindowsAppIdForName(name), appName: name }))) continue;
      results.push({ name, iconDataUrl: null });
    }
    for (const result of results) {
      result.iconDataUrl = await resolveWindowsAppIcon(result.name);
    }
    return results;
  };

  const fetchWindowsAppIcons = async (apps) => {
    const results = [];
    for (const name of Array.isArray(apps) ? apps : []) {
      const appName = String(name || '').trim();
      if (!appName) continue;
      const dataUrl = await resolveWindowsAppIcon(appName);
      if (dataUrl) results.push({ app: appName, data_url: dataUrl });
    }
    return results;
  };

  const buildWindowsOpenProjectSpecs = async ({ projectPath, appId, appName }) => {
    if (appId === 'finder') {
      return [{ program: 'explorer.exe', args: [projectPath] }];
    }
    if (appId === 'terminal') {
      const specs = [];
      const terminal = await findWindowsExecutable('terminal');
      if (terminal) {
        specs.push({ program: terminal, args: ['-d', projectPath] });
      }
      const shell = await runWhere('pwsh.exe') || await runWhere('powershell.exe');
      if (shell) {
        specs.push({ program: shell, args: ['-NoExit', '-Command', `Set-Location -LiteralPath ${JSON.stringify(projectPath)}`], shellStart: true });
      }
      const commandPrompt = env.ComSpec || await runWhere('cmd.exe');
      if (commandPrompt) {
        specs.push({ program: commandPrompt, args: ['/k', 'cd', '/d', projectPath], shellStart: true });
      }
      return specs;
    }
    return buildWindowsEditorSpecs({ targetPath: projectPath, appId, appName });
  };

  const buildWindowsOpenFileSpecs = async ({ filePath, appId, appName }) => {
    if (appId === 'terminal') {
      return buildWindowsOpenProjectSpecs({ projectPath: path.dirname(filePath), appId, appName });
    }
    return buildWindowsEditorSpecs({ targetPath: filePath, appId, appName });
  };

  const buildWindowsEditorSpecs = async ({ targetPath, appId, appName }) => {
    const specs = [];
    const cli = WINDOWS_CLI_BY_APP_ID[appId];
    if (cli) {
      const resolvedCli = await runWhere(cli);
      if (resolvedCli) {
        specs.push({ program: resolvedCli, args: [targetPath] });
      }
    }
    const exe = await findWindowsExecutable(appId);
    if (exe) {
      specs.push({ program: exe, args: [targetPath] });
    }
    const namedExe = await findWindowsAppNameExecutable(appName);
    if (namedExe && !specs.some((spec) => spec.program === namedExe)) {
      specs.push({ program: namedExe, args: [targetPath] });
    }
    return specs;
  };

  return {
    runWhere,
    buildWindowsInstalledApps,
    fetchWindowsAppIcons,
    buildWindowsOpenProjectSpecs,
    buildWindowsOpenFileSpecs,
  };
};
