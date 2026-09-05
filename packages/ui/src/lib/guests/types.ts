import type { AttachContribution, PublicAgent, PublicIntegration } from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

export type InstalledGuest = {
  id: string;
  name: string;
  icon: string;
  entry: string;
  attach?: AttachContribution;
  integration?: PublicIntegration;
  agent?: PublicAgent;
  source?: GuestSource;
  path?: string | null;
};
