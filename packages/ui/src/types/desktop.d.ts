import type { DesktopBootOutcome } from '@/lib/desktopBoot';

declare global {
  interface Window {
    __OPENCHAMBER_HOME__?: string;
    __OPENCHAMBER_MACOS_MAJOR__?: number;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
  }
}

export {};
