import type { AttachMode, GuestCapability, OpenChamberManifest, PublicSocketBinding } from '@openchamber/sdk';
import type { GitOrigin } from './persist.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type GuestPackage = Partial<Omit<OpenChamberManifest['contributes'], 'panel' | 'background' | 'page' | 'attach' | 'statusSection'>> & {
  id: string;
  name: string;
  icon: string;
  packageRoot: string;
  entry?: string;
  entryDock?: NonNullable<OpenChamberManifest['contributes']['panel']['dock']>;
  entrySize?: number;
  entryMobile?: true;
  backgroundEntry?: string;
  version?: string;
  engines?: OpenChamberManifest['engines'];
  attach?: AttachMode;
  attachEntry?: string;
  pageEntry?: string;
  pageTitle?: string;
  pageMobile?: true;
  statusEntry?: string;
  statusSource?: { path: string; interval: number };
  statusTitle?: string;
  statusHeight?: number;
  statusDefaultExpanded?: boolean;
  statusRequiresProject?: boolean;
};

export type GuestRecord = GuestPackage & {
  source?: string;
  path?: string | null;
  enabled?: boolean;
  capabilityGrants?: GuestCapability[];
  gitOrigin?: GitOrigin | undefined;
  socketBindings?: PublicSocketBinding[] | undefined;
  revision?: number;
  storageId?: unknown;
  enterpriseBlocked?: GuestCapability[];
  update?: { version: string };
};
