import type { IconName } from '@/components/icon/icons';

export type OpenInApp = {
  id: string;
  label: string;
  appName: string;
  /** The app's monochrome mark from the sprite (see scripts/icons/open-in-apps.mjs). */
  icon: IconName;
};

export const OPEN_IN_APPS: OpenInApp[] = [
  { id: 'finder', label: 'Finder', appName: 'Finder', icon: 'finder' },
  { id: 'terminal', label: 'Terminal', appName: 'Terminal', icon: 'terminal-box' },
  { id: 'iterm2', label: 'iTerm2', appName: 'iTerm', icon: 'app-iterm2' },
  { id: 'ghostty', label: 'Ghostty', appName: 'Ghostty', icon: 'app-ghostty' },
  { id: 'vscode', label: 'VS Code', appName: 'Visual Studio Code', icon: 'app-vscode' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', appName: 'Visual Studio Code - Insiders', icon: 'app-vscode' },
  { id: 'intellij', label: 'IntelliJ', appName: 'IntelliJ IDEA', icon: 'app-intellij' },
  { id: 'visual-studio', label: 'Visual Studio', appName: 'Visual Studio', icon: 'app-visual-studio' },
  { id: 'cursor', label: 'Cursor', appName: 'Cursor', icon: 'app-cursor' },
  { id: 'android-studio', label: 'Android Studio', appName: 'Android Studio', icon: 'app-android-studio' },
  { id: 'pycharm', label: 'PyCharm', appName: 'PyCharm', icon: 'app-pycharm' },
  { id: 'xcode', label: 'Xcode', appName: 'Xcode', icon: 'app-xcode' },
  { id: 'sublime-text', label: 'Sublime', appName: 'Sublime Text', icon: 'app-sublime-text' },
  { id: 'webstorm', label: 'WebStorm', appName: 'WebStorm', icon: 'app-webstorm' },
  { id: 'rider', label: 'Rider', appName: 'Rider', icon: 'app-rider' },
  { id: 'zed', label: 'Zed', appName: 'Zed', icon: 'app-zed' },
  { id: 'phpstorm', label: 'PhpStorm', appName: 'PhpStorm', icon: 'app-phpstorm' },
  { id: 'eclipse', label: 'Eclipse', appName: 'Eclipse', icon: 'app-eclipse' },
  { id: 'windsurf', label: 'Windsurf', appName: 'Windsurf', icon: 'app-windsurf' },
  { id: 'vscodium', label: 'VSCodium', appName: 'VSCodium', icon: 'app-vscodium' },
  { id: 'rustrover', label: 'RustRover', appName: 'RustRover', icon: 'app-rustrover' },
  { id: 'kiro', label: 'Kiro', appName: 'Kiro', icon: 'app-kiro' },
  { id: 'antigravity', label: 'Antigravity', appName: 'Antigravity', icon: 'app-antigravity' },
  { id: 'trae', label: 'Trae', appName: 'Trae', icon: 'app-trae' },
];

export const DEFAULT_OPEN_IN_APP_ID = 'finder';
export const OPEN_IN_ALWAYS_AVAILABLE_APP_IDS = new Set(['finder', 'terminal']);

export const getPlatformOpenInApp = (app: OpenInApp): OpenInApp => {
  if (typeof window === 'undefined') {
    return app;
  }

  const platform = window.__OPENCHAMBER_PLATFORM__;
  if (app.id === 'finder') {
    if (platform === 'win32') {
      return { ...app, label: 'Explorer', appName: 'File Explorer', icon: 'folder' };
    }
    if (platform === 'linux') {
      return { ...app, label: 'File Manager', icon: 'folder' };
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
