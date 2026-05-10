import type { DesktopBootOutcome } from '@/lib/desktopBoot';

declare global {
  interface Window {
    __ALIAS_ADE_HOME__?: string;
    __ALIAS_ADE_MACOS_MAJOR__?: number;
    __ALIAS_ADE_LOCAL_ORIGIN__?: string;
    __ALIAS_ADE_ELECTRON__?: { runtime?: string };
    __ALIAS_ADE_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
  }
}

export {};
