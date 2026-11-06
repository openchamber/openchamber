import type {
  AttachContribution,
  FileEditorContribution,
  GuestActionContribution,
  GuestBlockContribution,
  GuestCapability,
  GuestCommandContribution,
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
} from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

export type InstalledGuest = {
  id: string;
  /** Opaque server-issued identity for device-local extension preferences. */
  storageId?: string;
  name: string;
  icon: string;
  /** Visible panel page. Absent for background-only and tools-only extensions. */
  entry?: string;
  /** Edge and thickness of `entry` docked beside a shared surface (`PanelContribution.dock`/`size`). */
  entryDock?: GuestSurfaceDock;
  entrySize?: number;
  /** Sandboxed HTML loaded on demand for actions and commands, without a rail surface. */
  backgroundEntry?: string;
  /** npm package.json version when the package declared one. */
  version?: string;
  /** Times the server saw this package's files change since it started; frames reload when it moves. Absent is 0. */
  revision?: number;
  attach?: AttachContribution;
  /** HTML the attach dialog loads instead of `entry`; only sent for dialog-mode guests that declared one. */
  attachEntry?: string;
  pageEntry?: string;
  pageTitle?: string;
  /** HTML of the extension's Work Status section (`contributes.statusSection`); may exist without `entry`. */
  statusEntry?: string;
  /** Service path the host reads and draws the section from, without a frame; wins over `statusEntry`. */
  statusSource?: { path: string; interval: number };
  /** Section header title; the extension name when absent. */
  statusTitle?: string;
  /** Starting frame height in CSS px before the guest reports its own. */
  statusHeight?: number;
  /** Initial expansion state when the user has not saved a preference. */
  statusDefaultExpanded?: boolean;
  /** Whether this status section needs the Work Status directory. */
  statusRequiresProject?: boolean;
  integration?: PublicIntegration;
  /** Declared `contributes.filesystem` patterns, shown on the approval dialog. */
  filesystem?: string[];
  /** Declared `contributes.origins`: the frame may exchange data with them once approved. */
  origins?: string[];
  service?: PublicService;
  /** The Git host from `contributes.sourceControl`, when the service provides `source-control`. */
  sourceControl?: PublicSourceControl;
  /** The session events the service subscribed to (`contributes.sessionEvents`), for the approval dialog and the card. */
  sessionEvents?: PublicSessionEvents;
  /** The notification channel from `contributes.notifications`, when the service provides `notifications`. */
  notifications?: PublicNotifications;
  /** The tracker from `contributes.tracker`, when the service provides `tracker`. */
  tracker?: PublicTracker;
  /** The usage provider from `contributes.quota`, when the service provides `quota`: the OpenCode providers whose credentials it receives. */
  quota?: PublicQuota;
  /** The service acts on sessions by itself; `content` lets it read the agent's answers. */
  sessionControl?: { content: boolean };
  /** The service adds to what agents read. */
  instructions?: true;
  /** The package ships skills for every agent. */
  skills?: true;
  /** The package ships an OpenCode plugin, listed in the managed OpenCode config while the extension is on. */
  opencodePlugin?: true;
  /** The section the extension adds to the composer's `@` menu. */
  mentions?: { label: string };
  /** What the running service says is missing; shown on its card. */
  needsConfiguration?: string;
  /** Declared `contributes.blocks`; agents write them only for an active guest. */
  blocks?: GuestBlockContribution[];
  /** Declared `contributes.actions`; the UI shows them only for an active guest. */
  actions?: GuestActionContribution[];
  /** Declared `contributes.commands`; the composer routes them only for an active guest. */
  commands?: GuestCommandContribution[];
  /** Declared `contributes.tools`; the chat applies them only for an active guest. */
  tools?: GuestToolContribution[];
  /** Declared `contributes.fileEditors`; the Files view opens matching files in them only for an active guest. */
  fileEditors?: FileEditorContribution[];
  /** What the package asks for and what the user approved at install. */
  capabilities: PublicGuestCapabilities;
  /** Capabilities enterprise mode refuses this package: it is not from a repository the administrator allowed. */
  enterpriseBlocked?: GuestCapability[];
  source?: GuestSource;
  path?: string | null;
  /** False when the user disabled the extension. Omitted/true means enabled. */
  enabled?: boolean;
  /** Where a git install came from; the `ref` is the pinned branch or tag when the URL had `#ref`. */
  origin?: GuestGitOrigin;
  /** Set when the server's last update check found a newer `version` at `origin`. Git installs only. */
  update?: GuestUpdate;
};

/** A catalog row this build could not read; `id` and `name` are null when they were unreadable too. */
export type UnreadableGuest = { id: string | null; name: string | null; builtIn: boolean };

/**
 * How extensions' OpenCode plugins reach the OpenCode this server works with:
 * `file` through the managed config a managed OpenCode watches, `restart` merged
 * into `OPENCODE_CONFIG_CONTENT` for the next start (the user's environment sets
 * `OPENCODE_CONFIG`), `none` for an external OpenCode on this machine, `remote`
 * for one on another machine. `inGlobalConfig` names the extensions whose
 * plugin folder the user's global OpenCode config at `globalConfigPath` lists;
 * the path is null while no installed package ships a plugin, since the
 * server reads that config only then.
 */
export type OpenCodePluginDeliveryState = 'file' | 'restart' | 'none' | 'remote';

export type OpenCodePlugins = {
  delivery: OpenCodePluginDeliveryState;
  globalConfigPath: string | null;
  inGlobalConfig: string[];
};

export type GuestCatalog = { guests: InstalledGuest[]; unreadable: UnreadableGuest[]; opencodePlugins: OpenCodePlugins | null };

export type GuestGitOrigin = { url: string; ref?: string };

export type GuestUpdate = { version: string };
