import type { RuntimeAPIs, RuntimePlatform } from '@openchamber/ui/lib/api/types';
import { createWebTerminalAPI } from './terminal';
import { createWebGitAPI } from './git';
import { createWebFilesAPI } from './files';
import { createWebSettingsAPI } from './settings';
import { createWebPermissionsAPI } from './permissions';
import { createWebNotificationsAPI } from './notifications';
import { createWebToolsAPI } from './tools';
import { createWebPushAPI } from './push';
import { createWebGitHubAPI } from './github';

const isTauriShellRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function';
};

const hasDesktopLocalOriginHint = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  const localOrigin = (window as unknown as { __OPENCHAMBER_LOCAL_ORIGIN__?: unknown }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof localOrigin === 'string' && localOrigin.trim().length > 0;
};

const getInjectedRuntimePlatform = (): RuntimePlatform | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = (window as unknown as { __OPENCHAMBER_RUNTIME_PLATFORM__?: unknown }).__OPENCHAMBER_RUNTIME_PLATFORM__;
  if (value === 'desktop' || value === 'mobile' || value === 'vscode' || value === 'web') {
    return value;
  }
  return null;
};

const isLikelyMobileUserAgent = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod|android/.test(ua);
};

const isDesktopShellRuntime = (): boolean => {
  if (hasDesktopLocalOriginHint()) {
    return true;
  }
  return isTauriShellRuntime() && !isLikelyMobileUserAgent();
};

const resolveRuntimePlatform = (): RuntimePlatform => {
  const injected = getInjectedRuntimePlatform();
  if (injected) {
    return injected;
  }

  const candidate = import.meta.env.VITE_RUNTIME_PLATFORM;
  if (candidate === 'desktop' || candidate === 'mobile' || candidate === 'vscode' || candidate === 'web') {
    if (candidate === 'web') {
      return isDesktopShellRuntime() ? 'desktop' : 'web';
    }
    return candidate;
  }

  if (isDesktopShellRuntime()) {
    return 'desktop';
  }

  if (isTauriShellRuntime() && isLikelyMobileUserAgent()) {
    return 'mobile';
  }

  return 'web';
};

export const createWebAPIs = (): RuntimeAPIs => {
  const platform = resolveRuntimePlatform();

  return {
    runtime: {
      platform,
      isDesktop: platform === 'desktop',
      isVSCode: platform === 'vscode',
      label: platform,
    },
    terminal: createWebTerminalAPI(),
    git: createWebGitAPI(),
    files: createWebFilesAPI(),
    settings: createWebSettingsAPI(),
    permissions: createWebPermissionsAPI(),
    notifications: createWebNotificationsAPI(),
    github: createWebGitHubAPI(),
    push: createWebPushAPI(),
    tools: createWebToolsAPI(),
  };
};
