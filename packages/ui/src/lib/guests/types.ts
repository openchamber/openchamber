import type {
  AttachContribution,
  GuestActionContribution,
  GuestCommandContribution,
  PublicService,
  PublicGuestCapabilities,
  PublicIntegration,
} from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

export type InstalledGuest = {
  id: string;
  name: string;
  icon: string;
  entry: string;
  /** npm package.json version when the package declared one. */
  version?: string;
  attach?: AttachContribution;
  /** HTML the attach dialog loads instead of `entry`; only sent for dialog-mode guests that declared one. */
  attachEntry?: string;
  integration?: PublicIntegration;
  /** Declared `contributes.filesystem` patterns, shown on the approval dialog. */
  filesystem?: string[];
  service?: PublicService;
  /** Declared `contributes.actions`; the UI shows them only for an active guest. */
  actions?: GuestActionContribution[];
  /** Declared `contributes.commands`; the composer routes them only for an active guest. */
  commands?: GuestCommandContribution[];
  /** What the package asks for and what the user approved at install. */
  capabilities: PublicGuestCapabilities;
  source?: GuestSource;
  path?: string | null;
  /** False when the user disabled the extension. Omitted/true means enabled. */
  enabled?: boolean;
};
