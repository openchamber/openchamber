export type OpenInApp = {
  id: string;
  label: string;
  appName: string;
  supportsRemote: boolean;
  remoteFlag?: string;
};

export const OPEN_IN_APPS: OpenInApp[] = [
  { id: 'finder', label: 'Finder', appName: 'Finder', supportsRemote: false },
  { id: 'terminal', label: 'Terminal', appName: 'Terminal', supportsRemote: false },
  { id: 'iterm2', label: 'iTerm2', appName: 'iTerm', supportsRemote: false },
  { id: 'ghostty', label: 'Ghostty', appName: 'Ghostty', supportsRemote: false },
  { id: 'vscode', label: 'VS Code', appName: 'Visual Studio Code', supportsRemote: true, remoteFlag: 'ssh-remote' },
  { id: 'intellij', label: 'IntelliJ', appName: 'IntelliJ IDEA', supportsRemote: false },
  { id: 'visual-studio', label: 'Visual Studio', appName: 'Visual Studio', supportsRemote: false },
  { id: 'cursor', label: 'Cursor', appName: 'Cursor', supportsRemote: true, remoteFlag: 'ssh-remote' },
  { id: 'android-studio', label: 'Android Studio', appName: 'Android Studio', supportsRemote: false },
  { id: 'pycharm', label: 'PyCharm', appName: 'PyCharm', supportsRemote: false },
  { id: 'xcode', label: 'Xcode', appName: 'Xcode', supportsRemote: false },
  { id: 'sublime-text', label: 'Sublime', appName: 'Sublime Text', supportsRemote: false },
  { id: 'webstorm', label: 'WebStorm', appName: 'WebStorm', supportsRemote: false },
  { id: 'rider', label: 'Rider', appName: 'Rider', supportsRemote: false },
  { id: 'zed', label: 'Zed', appName: 'Zed', supportsRemote: false },
  { id: 'phpstorm', label: 'PhpStorm', appName: 'PhpStorm', supportsRemote: false },
  { id: 'eclipse', label: 'Eclipse', appName: 'Eclipse', supportsRemote: false },
  { id: 'windsurf', label: 'Windsurf', appName: 'Windsurf', supportsRemote: true, remoteFlag: 'ssh-remote' },
  { id: 'vscodium', label: 'VSCodium', appName: 'VSCodium', supportsRemote: true, remoteFlag: 'ssh-remote' },
  { id: 'rustrover', label: 'RustRover', appName: 'RustRover', supportsRemote: false },
  { id: 'kiro', label: 'Kiro', appName: 'Kiro', supportsRemote: false },
  { id: 'antigravity', label: 'Antigravity', appName: 'Antigravity', supportsRemote: false },
  { id: 'trae', label: 'Trae', appName: 'Trae', supportsRemote: false },
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
