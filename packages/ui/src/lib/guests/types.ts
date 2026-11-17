import type {
  AttachContribution,
  FileEditorContribution,
  GuestActionContribution,
  GuestBlockContribution,
  GuestCapability,
  GuestCommandContribution,
  GuestLinkAction,
  GuestSurfaceDock,
  GuestToolContribution,
  PublicService,
  PublicGuestCapabilities,
  PublicIntegration,
  PublicNotifications,
  PublicQuota,
  PublicTracker,
  PublicSessionEvents,
  PublicSourceControl,
  PublicWait,
} from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

export type InstalledGuest = {
  id: string;
  storageId?: string;
  name: string;
  icon: string;
  entry?: string;
  entryDock?: GuestSurfaceDock;
  entrySize?: number;
  entryMobile?: true;
  backgroundEntry?: string;
  version?: string;
  revision?: number;
  attach?: AttachContribution;
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
  integration?: PublicIntegration;
  filesystem?: string[];
  origins?: string[];
  service?: PublicService;
  sourceControl?: PublicSourceControl;
  sessionEvents?: PublicSessionEvents;
  waits?: Array<Pick<PublicWait, 'id' | 'title'>>;
  notifications?: PublicNotifications;
  tracker?: PublicTracker;
  quota?: PublicQuota;
  sessionControl?: { content: boolean };
  instructions?: true;
  marks?: true;
  skills?: true;
  opencodePlugin?: true;
  providerLogos?: Record<string, string>;
  mentions?: { label: string };
  links?: PublicGuestLinks;
  needsConfiguration?: string;
  blocks?: GuestBlockContribution[];
  actions?: GuestActionContribution[];
  commands?: GuestCommandContribution[];
  tools?: GuestToolContribution[];
  toolLinkSettings?: Record<string, string>;
  fileEditors?: FileEditorContribution[];
  capabilities: PublicGuestCapabilities;
  enterpriseBlocked?: GuestCapability[];
  source?: GuestSource;
  path?: string | null;
  enabled?: boolean;
  origin?: GuestGitOrigin;
  update?: GuestUpdate;
};

export type UnreadableGuest = { id: string | null; name: string | null; builtIn: boolean };

export type OpenCodePluginDeliveryState = 'file' | 'restart' | 'none' | 'remote';

export type OpenCodePlugins = {
  delivery: OpenCodePluginDeliveryState;
  globalConfigPath: string | null;
  inGlobalConfig: string[];
};

export type PublicGuestLinks = {
  action: GuestLinkAction;
  keys: string[];
  urls: {
    origin: string;
    identifierPattern: string;
    patterns: Array<{ path: string; query?: { name: string } }>;
    itemTemplate: string | null;
  } | null;
};

export type GuestCatalog = { guests: InstalledGuest[]; unreadable: UnreadableGuest[]; opencodePlugins: OpenCodePlugins | null };

export type GuestGitOrigin = { url: string; ref?: string };

export type GuestUpdate = { version: string };
