import type { DesktopBootOutcome } from '@/lib/desktopBoot';

export type OpenchamberMultiServerAPI = {
  listServers: () => Promise<Array<{
    id: string;
    label: string;
    type: string;
    status: string;
    url: string;
    error: string | null;
    sshStatus: { phase: string; localUrl: string | null; localPort: number | null } | null;
  }>>;
  registerServer: (config: { id: string; label: string; type: string; url: string }) => Promise<{
    id: string;
    label: string;
    type: string;
    status: string;
    url: string;
    error: string | null;
  }>;
  unregisterServer: (serverId: string) => Promise<{ ok: boolean }>;
  onServerStatusChange: (cb: (event: { serverId: string; phase: string; localUrl: string | null; status: string; detail: string | null }) => void) => () => void;
};

declare global {
  interface Window {
    __OPENCHAMBER_HOME__?: string;
    __OPENCHAMBER_MACOS_MAJOR__?: number;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    __OPENCHAMBER_ELECTRON__?: { runtime?: string };
    __OPENCHAMBER_PLATFORM__?: string;
    __OPENCHAMBER_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
    __OPENCHAMBER_MULTI_SERVER__?: OpenchamberMultiServerAPI;
  }

  interface WebviewElement extends HTMLElement {
    loadURL(url: string): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    getURL(): string;
    getTitle(): string;
    isLoading(): boolean;
    getWebContentsId(): number;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewElement> & {
          src?: string;
          partition?: string;
          preload?: string;
          nodeintegration?: string;
          allowpopups?: string;
          ref?: React.Ref<WebviewElement>;
        },
        WebviewElement
      >;
    }
  }
}

export {};
