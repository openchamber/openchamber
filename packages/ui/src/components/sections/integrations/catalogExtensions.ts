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
  /** A file name whose file-type icon is the card's logo. */
  logoFileName: string;
}

export const EXCALIDRAW_EXTENSION: CatalogExtensionDefinition = {
  guestId: 'excalidraw',
  gitUrl: 'https://github.com/openchamber/openchamber-excalidraw',
  homepage: 'https://github.com/openchamber/openchamber-excalidraw',
  nameKey: 'settings.integrations.extensionCatalog.excalidraw.name',
  descriptionKey: 'settings.integrations.extensionCatalog.excalidraw.description',
  logoFileName: 'drawing.excalidraw',
};

export const CATALOG_EXTENSIONS: readonly CatalogExtensionDefinition[] = [EXCALIDRAW_EXTENSION];

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
