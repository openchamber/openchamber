import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import { guestNeedsApproval } from '@/lib/guests/capabilities';
import type { InstalledGuest } from '@/lib/guests/types';

/** An OpenChamber extension the team publishes and the Integrations page offers to install. */
export interface CatalogExtensionDefinition {
  /** The extension's `panel.id`, which is its id once installed. */
  guestId: string;
  /** Installed through the same Git install as Settings → Extensions. */
  gitUrl: string;
  homepage: string;
  nameKey: I18nKey;
  descriptionKey: I18nKey;
  logo: CatalogExtensionLogo;
}

/** The card's logo: the file-type icon of a file the extension opens, or an app icon. */
export type CatalogExtensionLogo =
  | { kind: 'file-type'; fileName: string }
  | { kind: 'icon'; name: IconName };

export const EXCALIDRAW_EXTENSION: CatalogExtensionDefinition = {
  guestId: 'excalidraw',
  gitUrl: 'https://github.com/openchamber/openchamber-excalidraw',
  homepage: 'https://github.com/openchamber/openchamber-excalidraw',
  nameKey: 'settings.integrations.extensionCatalog.excalidraw.name',
  descriptionKey: 'settings.integrations.extensionCatalog.excalidraw.description',
  logo: { kind: 'file-type', fileName: 'drawing.excalidraw' },
};

export const RESOURCE_MONITOR_EXTENSION: CatalogExtensionDefinition = {
  guestId: 'resource-monitor',
  gitUrl: 'https://github.com/openchamber/openchamber-resource-monitor',
  homepage: 'https://github.com/openchamber/openchamber-resource-monitor',
  nameKey: 'settings.integrations.extensionCatalog.resourceMonitor.name',
  descriptionKey: 'settings.integrations.extensionCatalog.resourceMonitor.description',
  logo: { kind: 'icon', name: 'pulse' },
};

export const CATALOG_EXTENSIONS: readonly CatalogExtensionDefinition[] = [EXCALIDRAW_EXTENSION, RESOURCE_MONITOR_EXTENSION];

export type CatalogExtensionState =
  | { kind: 'not-installed' }
  | { kind: 'blocked'; guest: InstalledGuest }
  | { kind: 'needs-approval'; guest: InstalledGuest }
  | { kind: 'paused'; guest: InstalledGuest }
  | { kind: 'update-available'; guest: InstalledGuest; version: string }
  | { kind: 'installed'; guest: InstalledGuest };

/**
 * One state per card, from the installed catalog. Approval and pause outrank
 * an available update: the extension does nothing until they are resolved.
 */
export const getCatalogExtensionState = (
  guests: readonly InstalledGuest[],
  definition: CatalogExtensionDefinition,
): CatalogExtensionState => {
  const guest = guests.find((candidate) => candidate.id === definition.guestId);
  if (!guest) return { kind: 'not-installed' };
  // Enterprise mode refuses this package; no approval can change that.
  if (guest.enterpriseBlocked?.length) return { kind: 'blocked', guest };
  if (guestNeedsApproval(guest)) return { kind: 'needs-approval', guest };
  if (guest.enabled === false) return { kind: 'paused', guest };
  if (guest.update) return { kind: 'update-available', guest, version: guest.update.version };
  return { kind: 'installed', guest };
};
