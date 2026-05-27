export type OpenInApp = {
  id: string;
  label: string;
  appName: string;
};

export const OPEN_IN_APPS: OpenInApp[] = [
  { id: 'finder', label: 'Finder', appName: 'Finder' },
  { id: 'terminal', label: 'Terminal', appName: 'Terminal' },
  { id: 'iterm2', label: 'iTerm2', appName: 'iTerm' },
  { id: 'ghostty', label: 'Ghostty', appName: 'Ghostty' },
  { id: 'vscode', label: 'VS Code', appName: 'Visual Studio Code' },
  { id: 'intellij', label: 'IntelliJ', appName: 'IntelliJ IDEA' },
  { id: 'visual-studio', label: 'Visual Studio', appName: 'Visual Studio' },
  { id: 'cursor', label: 'Cursor', appName: 'Cursor' },
  { id: 'android-studio', label: 'Android Studio', appName: 'Android Studio' },
  { id: 'pycharm', label: 'PyCharm', appName: 'PyCharm' },
  { id: 'xcode', label: 'Xcode', appName: 'Xcode' },
  { id: 'sublime-text', label: 'Sublime', appName: 'Sublime Text' },
  { id: 'webstorm', label: 'WebStorm', appName: 'WebStorm' },
  { id: 'rider', label: 'Rider', appName: 'Rider' },
  { id: 'zed', label: 'Zed', appName: 'Zed' },
  { id: 'phpstorm', label: 'PhpStorm', appName: 'PhpStorm' },
  { id: 'eclipse', label: 'Eclipse', appName: 'Eclipse' },
  { id: 'windsurf', label: 'Windsurf', appName: 'Windsurf' },
  { id: 'vscodium', label: 'VSCodium', appName: 'VSCodium' },
  { id: 'rustrover', label: 'RustRover', appName: 'RustRover' },
  { id: 'kiro', label: 'Kiro', appName: 'Kiro' },
  { id: 'antigravity', label: 'Antigravity', appName: 'Antigravity' },
  { id: 'trae', label: 'Trae', appName: 'Trae' },
];

export const DEFAULT_OPEN_IN_APP_ID = 'finder';
export const OPEN_IN_ALWAYS_AVAILABLE_APP_IDS = new Set(['finder', 'terminal']);
export const OPEN_DIRECTORY_APP_IDS = new Set(['finder', 'terminal', 'iterm2', 'ghostty']);

export const getPlatformOpenInApp = (app: OpenInApp): OpenInApp => {
  if (typeof window !== 'undefined' && window.__OPENCHAMBER_PLATFORM__ === 'win32') {
    if (app.id === 'finder') {
      return { ...app, label: 'Explorer', appName: 'File Explorer' };
    }
  }
  return app;
};

export const getOpenInAppById = (id: string | null | undefined): OpenInApp | null => {
  if (!id) {
    return null;
  }
  const app = OPEN_IN_APPS.find((candidate) => candidate.id === id) ?? null;
  return app ? getPlatformOpenInApp(app) : null;
};

export const getDefaultOpenInApp = (): OpenInApp => {
  return getOpenInAppById(DEFAULT_OPEN_IN_APP_ID) ?? getPlatformOpenInApp(OPEN_IN_APPS[0]);
};
