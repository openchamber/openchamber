declare global {
  interface Window {
    __OPENCHAMBER_HOME__?: string;
    __OPENCHAMBER_MACOS_MAJOR__?: number;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    __OPENCHAMBER_RUNTIME_PLATFORM__?: 'desktop' | 'mobile' | 'web' | 'vscode';
    __OPENCHAMBER_DESKTOP_SERVER__?: {
      origin: string;
      opencodePort: number | null;
      apiPrefix: string;
      cliAvailable: boolean;
    };
  }
}

export {};
