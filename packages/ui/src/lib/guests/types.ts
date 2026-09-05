import type { AttachContribution, PublicAgent, PublicIntegration } from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

export type InstalledGuest = {
  id: string;
  name: string;
  icon: string;
  entry: string;
  /** npm package.json version when the package declared one. */
  version?: string;
  attach?: AttachContribution;
  integration?: PublicIntegration;
  agent?: PublicAgent;
  source?: GuestSource;
  path?: string | null;
  /** False when the user disabled the extension. Omitted/true means enabled. */
  enabled?: boolean;
};
