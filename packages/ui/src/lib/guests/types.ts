import type {
  AttachContribution,
  GuestActionContribution,
  GuestCommandContribution,
  GuestSurfaceDock,
  GuestToolContribution,
  PublicService,
  PublicGuestCapabilities,
  PublicIntegration,
} from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

export type InstalledGuest = {
  id: string;
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
  attach?: AttachContribution;
  /** HTML the attach dialog loads instead of `entry`; only sent for dialog-mode guests that declared one. */
  attachEntry?: string;
  pageEntry?: string;
  pageTitle?: string;
  integration?: PublicIntegration;
  /** Declared `contributes.filesystem` patterns, shown on the approval dialog. */
  filesystem?: string[];
  service?: PublicService;
  /** Declared `contributes.actions`; the UI shows them only for an active guest. */
  actions?: GuestActionContribution[];
  /** Declared `contributes.commands`; the composer routes them only for an active guest. */
  commands?: GuestCommandContribution[];
  /** Declared `contributes.tools`; the chat applies them only for an active guest. */
  tools?: GuestToolContribution[];
  /** What the package asks for and what the user approved at install. */
  capabilities: PublicGuestCapabilities;
  source?: GuestSource;
  path?: string | null;
  /** False when the user disabled the extension. Omitted/true means enabled. */
  enabled?: boolean;
  /** Where a git install came from; the `ref` is the pinned branch or tag when the URL had `#ref`. */
  origin?: GuestGitOrigin;
  /** Set when the server's last update check found a newer `version` at `origin`. Git installs only. */
  update?: GuestUpdate;
};

export type GuestGitOrigin = { url: string; ref?: string };

export type GuestUpdate = { version: string };
