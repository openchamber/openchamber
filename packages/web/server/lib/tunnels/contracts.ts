import type { TunnelCapabilities, TunnelStartRequest } from './types.js';

export interface TunnelController {
  provider?: string;
  mode?: string;
  httpsPort?: number;
  stop?: () => void;
  getPublicUrl?: () => string | null;
  getEffectiveConfigPath?: () => string | null;
  getResolvedHostname?: () => string | null;
}

export interface TunnelProviderMetadata {
  configPath: string | null;
  resolvedHostname: string | null;
}

export interface TunnelAvailability {
  available: boolean;
  version?: string | null;
  dependency?: string;
  installCommand?: string;
  installUrl?: string;
  platform?: NodeJS.Platform;
  message?: string;
}

export interface TunnelStartContext {
  activePort: number | null;
  originUrl: string | undefined;
}

export interface TunnelDoctorRequest {
  mode: string | null | undefined;
  hostname: string | undefined;
  token: string;
  tokenProvided: boolean;
  hostnameProvided: boolean;
  configPath: string | null | undefined;
  hasSavedManagedRemoteProfile: boolean;
}

export interface TunnelDoctorCheck {
  id: string;
  label: string;
  status: string;
  detail: string | null | undefined;
}

export interface TunnelDoctorMode {
  mode: string;
  checks: TunnelDoctorCheck[];
  summary: { ready: boolean; failures: number; warnings: number };
  ready: boolean;
  blockers: (string | null | undefined)[];
}

export interface TunnelProvider {
  id: string;
  capabilities: TunnelCapabilities;
  checkAvailability: () => Promise<TunnelAvailability>;
  start: (request: TunnelStartRequest, context: TunnelStartContext) => Promise<TunnelController>;
  stop: (controller: TunnelController) => void;
  resolvePublicUrl: (controller: TunnelController | null) => string | null;
  getMetadata?: (controller: TunnelController | null) => TunnelProviderMetadata | null;
  diagnose?: (request: TunnelDoctorRequest, context: { capabilities: TunnelCapabilities }) => Promise<{
    providerChecks: TunnelDoctorCheck[];
    modes: TunnelDoctorMode[];
  }>;
}
